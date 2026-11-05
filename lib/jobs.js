/**
 * Scheduled jobs: nightly wealth-profit refresh and the month-end report.
 *
 * Both jobs are idempotent. `job_runs` is keyed by `job_key` (e.g.
 * `daily_profit:2026-10-31`); a successful run makes the next invocation a
 * no-op. Month-end reports are additionally keyed by month in
 * `monthly_reports`, so a retried job can never overwrite a delivered report.
 *
 * `ctx.schedule` is the host's cron service. When it is absent the module
 * throws `schedule_unavailable`; the tool layer turns that into a readable
 * failure instead of a turn-ending exception.
 * @module dsh-ledger-wealth/jobs
 */

import { assertDate, assertMonth, dateInZone, isMonthEnd, monthKeyOf, nowIso } from './dates.js'
import { transaction } from './db.js'
import { CODES, fail } from './errors.js'
import { newId } from './db.js'

/** Job kinds stored in `job_runs.kind`. */
export const JOB = {
  daily: 'daily_profit',
  monthly: 'month_end_report',
}

/** Titles of the two schedules (used for reuse detection and status output). */
export const SCHEDULE_TITLES = {
  daily: '每日理财收益刷新',
  monthly: '月末报告生成',
}

/**
 * Stable identity of one job run.
 * @param {string} kind JOB.daily | JOB.monthly
 * @param {string} dateOrMonth 'YYYY-MM-DD' for daily, 'YYYY-MM' for monthly
 */
export function jobKey(kind, dateOrMonth) {
  return `${kind}:${dateOrMonth}`
}

/** Validate a date, translating TypeError into a LedgerError. */
function requireDate(value, field = 'date') {
  try {
    return assertDate(value, field)
  } catch (error) {
    throw fail(CODES.invalid_date, `${field} 必须是真实日期（YYYY-MM-DD）：${String(value)}`, {
      field,
      detail: error instanceof Error ? error.message : String(error),
    })
  }
}

/** Validate a month key, translating TypeError into a LedgerError. */
function requireMonth(value) {
  try {
    return assertMonth(String(value))
  } catch (error) {
    throw fail(CODES.invalid_month, `月份必须是 YYYY-MM：${String(value)}`, {
      detail: error instanceof Error ? error.message : String(error),
    })
  }
}

/** Upsert one job_runs row (PK = job_key). */
function recordJobRun(db, { key, kind, status, summary, ranAt }) {
  const payload = summary === undefined || summary === null ? null : JSON.stringify(summary)
  db.prepare(
    `INSERT INTO job_runs (job_key, kind, status, summary, ran_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (job_key) DO UPDATE SET
       kind = excluded.kind, status = excluded.status,
       summary = excluded.summary, ran_at = excluded.ran_at`,
  ).run(key, kind, status, payload, ranAt)
}

/** Read the existing job_runs row for a key, or null. */
function readJobRun(db, key) {
  return db.prepare('SELECT job_key, kind, status, summary, ran_at FROM job_runs WHERE job_key = ?').get(key) ?? null
}

/** Persist job alerts (module: wealth) and return how many were written. */
function writeAlerts(db, alerts, module, createdAt) {
  const list = Array.isArray(alerts) ? alerts : []
  let written = 0
  const insert = db.prepare(
    'INSERT INTO alerts (id, created_at, module, level, message, resolved) VALUES (?, ?, ?, ?, ?, 0)',
  )
  for (const alert of list) {
    const message = typeof alert?.message === 'string' ? alert.message.trim() : ''
    if (message === '') continue
    const level = ['info', 'warning', 'error'].includes(alert?.level) ? alert.level : 'warning'
    insert.run(newId('alert'), createdAt, module, level, message)
    written += 1
  }
  return written
}

/**
 * Run the nightly wealth-profit refresh.
 *
 * Delegates to `refreshDailyProfits` from `lib/profit.js`; a `refreshImpl`
 * may be injected (tests, or a future alternative source) so the job does not
 * hard-depend on that module at import time.
 * @param {{
 *   db: import('node:sqlite').DatabaseSync,
 *   config: Record<string, unknown>,
 *   profitDate?: string,
 *   today?: string,
 *   refreshImpl?: (db: unknown, options: { profitDate: string, config: unknown }) => Promise<unknown>,
 * }} input
 * @returns {Promise<{ skipped: boolean, profit_date: string, updated_count: number,
 *   missing_count: number, alerts: Array<{ level: string, message: string }>,
 *   updated?: unknown[], missing?: unknown[], all_failed?: boolean, reason?: string }>}
 */
export async function runDailyProfitJob({ db, config = {}, profitDate, today, refreshImpl } = {}) {
  const now = new Date()
  const ranAt = nowIso(now)
  const day = requireDate(today ?? dateInZone(now, config.timeZone ?? 'Asia/Shanghai'), 'today')
  const target = requireDate(profitDate ?? day, 'profitDate')
  const key = jobKey(JOB.daily, target)

  const previous = readJobRun(db, key)
  if (previous !== null && previous.status === 'ok') {
    return {
      skipped: true,
      profit_date: target,
      updated_count: 0,
      missing_count: 0,
      alerts: [],
      reason: 'already_ran',
      ran_at: previous.ran_at,
    }
  }

  let refresh = refreshImpl
  if (typeof refresh !== 'function') {
    const module = await import('./profit.js')
    refresh = module.refreshDailyProfits
  }
  if (typeof refresh !== 'function') {
    throw fail(CODES.internal_error, '理财收益模块缺少 refreshDailyProfits 导出，无法刷新收益。')
  }

  let result
  try {
    result = await refresh(db, { profitDate: target, config })
  } catch (error) {
    const message = `每日理财收益刷新失败：${error instanceof Error ? error.message : String(error)}`
    const alerts = [{ level: 'error', message }]
    transaction(db, () => {
      writeAlerts(db, alerts, 'wealth', ranAt)
      recordJobRun(db, {
        key,
        kind: JOB.daily,
        status: 'failed',
        summary: { profit_date: target, error: message },
        ranAt,
      })
    })
    return {
      skipped: false,
      profit_date: target,
      updated_count: 0,
      missing_count: 0,
      alerts,
      all_failed: true,
      error: message,
    }
  }

  const updated = Array.isArray(result?.updated) ? result.updated : []
  const missing = Array.isArray(result?.missing) ? result.missing : []
  const alerts = Array.isArray(result?.alerts) ? result.alerts : []
  const allFailed = Boolean(result?.all_failed)
  transaction(db, () => {
    writeAlerts(db, alerts, 'wealth', ranAt)
    recordJobRun(db, {
      key,
      kind: JOB.daily,
      status: allFailed ? 'failed' : 'ok',
      summary: { profit_date: target, updated_count: updated.length, missing_count: missing.length },
      ranAt,
    })
  })
  return {
    skipped: false,
    profit_date: target,
    updated_count: updated.length,
    missing_count: missing.length,
    updated,
    missing,
    alerts,
    all_failed: allFailed,
  }
}

/**
 * Run the month-end report job.
 *
 * The first time a month is generated the report is persisted into
 * `monthly_reports`, which is the second idempotency guard (PK = month).
 * @param {{
 *   db: import('node:sqlite').DatabaseSync,
 *   config: Record<string, unknown>,
 *   month?: string,
 *   today?: string,
 *   report?: Record<string, unknown>,
 * }} input
 * @returns {Promise<{ skipped: boolean, month: string, reason?: string,
 *   report?: Record<string, unknown> }>}
 */
export async function runMonthEndJob({ db, config = {}, month, today, report } = {}) {
  const now = new Date()
  const ranAt = nowIso(now)
  const day = requireDate(today ?? dateInZone(now, config.timeZone ?? 'Asia/Shanghai'), 'today')
  const explicitMonth = month !== undefined && month !== null && String(month).trim() !== ''
  const targetMonth = explicitMonth ? requireMonth(month) : requireMonth(monthKeyOf(day))

  // The cron fires daily on the 28th-31st; only the real last day may generate.
  if (!explicitMonth && !isMonthEnd(day)) {
    return { skipped: true, month: targetMonth, reason: 'not_month_end' }
  }

  const existingReport = db.prepare('SELECT month FROM monthly_reports WHERE month = ?').get(targetMonth)
  if (existingReport) {
    return { skipped: true, month: targetMonth, reason: 'report_exists' }
  }
  const key = jobKey(JOB.monthly, targetMonth)
  const previous = readJobRun(db, key)
  if (previous !== null && previous.status === 'ok') {
    return { skipped: true, month: targetMonth, reason: 'already_ran' }
  }

  let reportValue = report
  if (reportValue === undefined || reportValue === null) {
    const module = await import('./report.js')
    reportValue = module.buildMonthlyReport(db, {
      month: targetMonth,
      timeZone: config.timeZone ?? 'Asia/Shanghai',
      today: day,
      now,
    })
  }
  if (typeof reportValue?.rendered !== 'string' || reportValue.rendered.trim() === '') {
    throw fail(CODES.internal_error, '月末报告内容为空，无法保存。', { month: targetMonth })
  }

  transaction(db, () => {
    db.prepare(
      `INSERT INTO monthly_reports (month, ledger_json, wealth_json, rendered, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (month) DO UPDATE SET
         ledger_json = excluded.ledger_json,
         wealth_json = excluded.wealth_json,
         rendered = excluded.rendered,
         created_at = excluded.created_at`,
    ).run(
      targetMonth,
      JSON.stringify(reportValue.ledger ?? null),
      JSON.stringify(reportValue.wealth ?? null),
      reportValue.rendered,
      ranAt,
    )
    recordJobRun(db, {
      key,
      kind: JOB.monthly,
      status: 'ok',
      summary: {
        month: targetMonth,
        ledger_entries: reportValue?.ledger?.entry_count ?? null,
        missing_products: reportValue?.wealth?.missing_product_count ?? null,
      },
      ranAt,
    })
  })
  return { skipped: false, month: targetMonth, report: reportValue }
}

/**
 * Self-contained prompts for the two scheduled turns. A schedule wakes a brand
 * new turn, so each prompt repeats the tool name, the expected reporting style
 * and the "never invent numbers / never add ledger to wealth" rule.
 * @param {Record<string, unknown>} [config] resolved plugin config
 * @returns {{ daily: string, monthly: string }}
 */
export function schedulePrompts(config = {}) {
  const timeZone = typeof config?.timeZone === 'string' ? config.timeZone : 'Asia/Shanghai'
  const daily = [
    '【自动任务 · 每日理财收益刷新】',
    `现在是 ${timeZone} 时区的每日定时唤醒。请立刻调用 finance_run_daily_job 工具（无需向用户确认，也不需要等待授权）。`,
    '该工具会按降级链为所有在持理财产品写入当日收益。拿到结果后请用 2-3 句中文汇报：更新了几个产品、哪些产品数据源不可用、是否有警告。',
    '若返回 skipped（当天已执行过），只说明「今日收益已刷新过」，不要重复执行。',
    '只汇报理财收益，禁止把理财数字与日常记账金额相加，也不要编造任何收益数字。',
  ].join('\n')
  const monthly = [
    '【自动任务 · 月末报告】',
    `现在是 ${timeZone} 时区的月末检查（每月 28-31 日每天触发）。请调用 finance_run_month_end_job 工具，它只在今天确实是本月最后一个自然日时才生成报告。`,
    '若返回 skipped 且 reason 为 not_month_end：用一句中文说明「本月还没结束，月末报告将在最后一天生成」，然后结束本轮。',
    '若返回 skipped 且 reason 为 report_exists 或 already_ran：说明该月报告已生成，不要重复生成。',
    '若生成成功：把 report.rendered 全文原样输出给用户，保留两节之间的分隔线，不要改写、不要合并或相加两节金额，不要补写不存在的数据。',
    '数据源不可用时，按报告里标注的「数据源暂不可用 / 上次更新值」说明，不要猜测或编造任何数字。',
  ].join('\n')
  return { daily, monthly }
}

/** Normalize whatever `ctx.schedule.list` returns into an array. */
async function listSchedules(service, sessionId) {
  let raw
  try {
    raw = await service.list({ sessionId })
  } catch (error) {
    throw fail(CODES.schedule_unavailable, `读取定时任务列表失败：${error instanceof Error ? error.message : String(error)}`, {
      hint: '请确认当前 DSH 版本的定时任务服务可用，或稍后重试。',
    })
  }
  if (Array.isArray(raw)) return raw
  if (Array.isArray(raw?.schedules)) return raw.schedules
  if (Array.isArray(raw?.items)) return raw.items
  if (Array.isArray(raw?.list)) return raw.list
  return []
}

/** Extract the id of a created schedule (the service may return an object or a string). */
function scheduleIdOf(value) {
  if (typeof value === 'string' && value.trim() !== '') return value
  if (value && typeof value === 'object') {
    const candidates = [value.id, value.scheduleId, value.schedule?.id]
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate !== '') return candidate
    }
  }
  return null
}

/** True when an existing schedule is the one we are about to create. */
function isSameSchedule(existing, job) {
  const title = typeof existing?.title === 'string' ? existing.title.trim() : ''
  if (title !== '' && title === job.title) return true
  const expression = existing?.cron?.expression ?? existing?.cron?.expr ?? existing?.cron
  if (typeof expression === 'string' && expression.trim() === job.cron.expression) {
    const prompt = typeof existing?.prompt === 'string' ? existing.prompt : ''
    if (prompt === job.prompt) return true
  }
  return false
}

/**
 * Create (or reuse) the two schedules in `ctx.schedule`.
 * @param {{ schedule?: { create: Function, list: Function } }} ctx host context
 * @param {{ config?: Record<string, unknown>, sessionId?: string }} input
 * @returns {Promise<{ created: string[], reused: string[], prompts: { daily: string, monthly: string } }>}
 */
export async function setupSchedules(ctx, { config = {}, sessionId } = {}) {
  const service = ctx?.schedule
  if (!service || typeof service.create !== 'function') {
    throw fail(
      CODES.schedule_unavailable,
      '当前 DSH 环境没有提供定时任务服务（ctx.schedule），无法自动创建定时任务。',
      { hint: '可以在 DSH 的定时任务设置里手动创建，或确认 dsh 版本支持 schedule 服务。' },
    )
  }
  const sid = typeof sessionId === 'string' ? sessionId.trim() : ''
  if (sid === '') {
    throw fail(CODES.invalid_argument, '缺少会话 id，无法把定时任务绑定到当前会话。', { field: 'sessionId' })
  }
  const timeZone = typeof config.timeZone === 'string' ? config.timeZone : 'Asia/Shanghai'
  const prompts = schedulePrompts(config)
  const jobs = [
    {
      title: SCHEDULE_TITLES.daily,
      prompt: prompts.daily,
      cron: { expression: config.dailyJobCron ?? '0 20 * * *', time_zone: timeZone },
    },
    {
      title: SCHEDULE_TITLES.monthly,
      prompt: prompts.monthly,
      cron: { expression: config.monthlyJobCron ?? '0 21 28-31 * *', time_zone: timeZone },
    },
  ]
  const existing = await listSchedules(service, sid)
  const created = []
  const reused = []
  for (const job of jobs) {
    const found = existing.find((item) => isSameSchedule(item, job))
    if (found) {
      reused.push(scheduleIdOf(found) ?? job.title)
      continue
    }
    let value
    try {
      value = await service.create(sid, { prompt: job.prompt, title: job.title, cron: job.cron })
    } catch (error) {
      throw fail(
        CODES.schedule_unavailable,
        `创建定时任务「${job.title}」失败：${error instanceof Error ? error.message : String(error)}`,
        { hint: '请检查 DSH 定时任务服务是否正常，或在设置里手动创建。' },
      )
    }
    created.push(scheduleIdOf(value) ?? job.title)
  }
  return { created, reused, prompts }
}
