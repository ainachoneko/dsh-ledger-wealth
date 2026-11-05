/**
 * Job tools: manual triggers, schedule setup and schedule status.
 *
 * All four tools share `lib/jobs.js`, so a manual run and a cron run go through
 * exactly the same idempotency guards (`job_runs` / `monthly_reports`).
 * @module dsh-ledger-wealth/tools/jobs
 */

import { dateInZone } from '../dates.js'
import { CODES, fail } from '../errors.js'
import { JOB, runDailyProfitJob, runMonthEndJob, setupSchedules } from '../jobs.js'
import { registerJsonTool, sessionIdOf } from '../toolkit.js'

/** Normalize whatever `ctx.schedule.list` returns into an array. */
function normalizeSchedules(raw) {
  if (Array.isArray(raw)) return raw
  if (Array.isArray(raw?.schedules)) return raw.schedules
  if (Array.isArray(raw?.items)) return raw.items
  if (Array.isArray(raw?.list)) return raw.list
  return []
}

/** Read the last job runs for the status tool. */
function readLastRuns(db, limit = 10) {
  return db
    .prepare('SELECT job_key, kind, status, summary, ran_at FROM job_runs ORDER BY ran_at DESC LIMIT ?')
    .all(limit)
}

/** Read generated month-end reports (month + created_at). */
function readReports(db, limit = 6) {
  return db.prepare('SELECT month, created_at FROM monthly_reports ORDER BY month DESC LIMIT ?').all(limit)
}

/** Chinese summary of a daily run. */
function renderDailyText(result) {
  if (result.skipped) {
    return `每日理财收益任务（${result.profit_date}）今天已执行过，跳过重复执行。`
  }
  const lines = [
    `每日理财收益刷新（${result.profit_date}）：更新 ${result.updated_count} 个产品，缺失 ${result.missing_count} 个。`,
  ]
  if (result.all_failed) lines.push('警告：所有理财数据源均不可用，本次没有写入任何收益数字。')
  for (const alert of result.alerts ?? []) lines.push(`提醒（${alert.level ?? 'warning'}）：${alert.message}`)
  if (result.error) lines.push(`错误：${result.error}`)
  lines.push('以上仅为理财模块数字，不与日常记账金额合并。')
  return lines.join('\n')
}

/** Chinese summary of a month-end run. */
function renderMonthText(result) {
  if (result.skipped) {
    if (result.reason === 'not_month_end') {
      return `今天（${result.month}）不是本月最后一个自然日，月末报告任务已跳过；报告将在月末最后一天生成。`
    }
    if (result.reason === 'report_exists') {
      return `${result.month} 的月度报告已存在，跳过重复生成（避免覆盖已交付内容）。`
    }
    if (result.reason === 'already_ran') {
      return `${result.month} 的月末报告任务已执行过，跳过重复执行。`
    }
    return `${result.month} 的月末报告任务已跳过。`
  }
  return (
    `已生成 ${result.month} 月度报告：记账与理财分两节，中间以分隔线隔开，两部分金额不做任何合并。` +
    '可直接展示 report.rendered 给用户。'
  )
}

/** Chinese summary of schedule status. */
function renderStatusText({ schedules, lastRuns, reports, scheduleService }) {
  const lines = []
  if (!scheduleService) {
    lines.push('当前 DSH 环境没有提供定时任务服务（ctx.schedule），无法读取定时任务列表。')
  } else if (schedules.length === 0) {
    lines.push('当前会话还没有创建定时任务，可调用 finance_setup_schedules 创建。')
  } else {
    lines.push(`当前会话有 ${schedules.length} 个定时任务：`)
    for (const schedule of schedules) {
      const cron = schedule?.cron?.expression ?? schedule?.cron ?? '—'
      const zone = schedule?.cron?.time_zone ?? schedule?.timeZone ?? '—'
      lines.push(`- ${schedule?.title ?? schedule?.id ?? '未命名'}｜cron ${cron}（${zone}）`)
    }
  }
  if (lastRuns.length > 0) {
    lines.push('最近任务运行：')
    for (const run of lastRuns.slice(0, 5)) {
      lines.push(`- ${run.job_key}｜${run.status}｜${run.ran_at}`)
    }
  } else {
    lines.push('还没有任务运行记录。')
  }
  if (reports.length > 0) lines.push(`已生成的月度报告：${reports.map((row) => row.month).join('、')}`)
  return lines.join('\n')
}

/**
 * Register the job/schedule tools on the host context.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ db: import('node:sqlite').DatabaseSync, config: Record<string, unknown>,
 *   today?: () => string }} deps
 */
export function registerJobsTools(ctx, deps) {
  const { db, config } = deps ?? {}
  if (!db) throw fail(CODES.invalid_config, '缺少数据库实例，无法注册任务工具。', { field: 'db' })
  const cfg = config ?? {}
  const todayOf =
    typeof deps?.today === 'function' ? deps.today : () => dateInZone(new Date(), cfg.timeZone ?? 'Asia/Shanghai')

  registerJsonTool(ctx, {
    name: 'finance_run_daily_job',
    description:
      '立即执行每日理财收益刷新（幂等：当天已成功执行则返回 skipped）。按降级链写入各产品昨日/今日收益，' +
      '数据源不可用时写 alerts，绝不使用年化收益率推算。仅涉及理财模块，不与记账金额合并。',
    parameters: {
      date: { type: 'string', description: '收益日期 YYYY-MM-DD，默认今天（配置时区）' },
    },
    async execute(args) {
      const date = typeof args?.date === 'string' && args.date.trim() !== '' ? args.date.trim() : undefined
      const today = todayOf()
      const result = await runDailyProfitJob({ db, config: cfg, profitDate: date, today })
      return { ok: true, result, text: renderDailyText(result) }
    },
  })

  registerJsonTool(ctx, {
    name: 'finance_run_month_end_job',
    description:
      '生成并保存月末报告（幂等：该月报告已存在则返回 skipped）。报告分「记账」「理财」两节，中间有分隔线，' +
      '两节金额互不合并；返回 report.rendered 为完整中文报告。',
    parameters: {
      month: { type: 'string', description: '月份 YYYY-MM，默认本月；显式传入可补生成历史月份' },
    },
    async execute(args) {
      const month = typeof args?.month === 'string' && args.month.trim() !== '' ? args.month.trim() : undefined
      const today = todayOf()
      const result = await runMonthEndJob({ db, config: cfg, month, today })
      const body = { ok: true, result, text: renderMonthText(result) }
      if (result.report) body.report = result.report
      return body
    },
  })

  registerJsonTool(ctx, {
    name: 'finance_setup_schedules',
    description:
      '为当前会话创建两个定时任务：每日理财收益刷新、月末报告生成。已存在同名任务则复用，不会重复创建。' +
      '需要 DSH 环境提供 ctx.schedule 服务，否则返回 schedule_unavailable。',
    parameters: {},
    async execute(_args, exec) {
      const sessionId = sessionIdOf(exec)
      if (!sessionId) {
        throw fail(CODES.invalid_argument, '缺少会话 id，无法把定时任务绑定到当前会话。', { field: 'sessionId' })
      }
      const result = await setupSchedules(ctx, { config: cfg, sessionId })
      const lines = []
      lines.push(result.created.length > 0 ? `已创建 ${result.created.length} 个定时任务。` : '没有新建定时任务。')
      lines.push(result.reused.length > 0 ? `复用已有任务 ${result.reused.length} 个。` : '')
      lines.push(`每日任务 cron：${cfg.dailyJobCron ?? '0 20 * * *'}（${cfg.timeZone ?? 'Asia/Shanghai'}）`)
      lines.push(`月末任务 cron：${cfg.monthlyJobCron ?? '0 21 28-31 * *'}（每日检查，仅月末最后一天生成）`)
      return { ok: true, created: result.created, reused: result.reused, text: lines.filter(Boolean).join('\n') }
    },
  })

  registerJsonTool(ctx, {
    name: 'finance_schedule_status',
    description: '查看当前会话的定时任务列表、最近任务运行记录与已生成的月度报告月份。',
    parameters: {},
    async execute(_args, exec) {
      const sessionId = sessionIdOf(exec)
      const service = ctx?.schedule
      const scheduleService = Boolean(service && typeof service.list === 'function')
      let schedules = []
      let scheduleError = null
      if (scheduleService && sessionId) {
        try {
          schedules = normalizeSchedules(await service.list({ sessionId }))
        } catch (error) {
          scheduleError = error instanceof Error ? error.message : String(error)
        }
      }
      const lastRuns = readLastRuns(db)
      const reports = readReports(db)
      return {
        ok: true,
        schedules,
        last_runs: lastRuns,
        reports,
        schedule_service: scheduleService,
        schedule_error: scheduleError,
        text: renderStatusText({ schedules, lastRuns, reports, scheduleService }),
      }
    },
  })
}

export { JOB }
