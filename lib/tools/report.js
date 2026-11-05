/**
 * Report / status tools owned by the integration layer.
 *
 * These tools only read. The month-end job (owned by the jobs module) is the
 * single writer of `monthly_reports`, which keeps report generation idempotent.
 * @module dsh-ledger-wealth/tools/report
 */

import { CODES, fail } from '../errors.js'
import { buildMonthlyReport } from '../report.js'
import { getMeta, getMetaInt, TABLES } from '../db.js'
import { registerJsonTool } from '../toolkit.js'

function countRows(db, table) {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()
  return Number(row?.n ?? 0)
}

/** Register the monthly-report, alert and status tools. */
export function registerReportTools(ctx, { db, config, dbPath, today }) {
  registerJsonTool(ctx, {
    name: 'finance_monthly_report',
    description:
      '生成指定月份的月度报告：先「记账部分（日常收支）」，再「理财部分（与日常记账分开）」。' +
      '两部分金额物理隔离、不合并计算；数据源不可用的理财项会明确标注。不写库，可随时调用。',
    parameters: {
      month: { type: 'string', description: '月份 YYYY-MM，缺省为当前月' },
    },
    async execute(args) {
      const month = typeof args.month === 'string' && args.month.trim() !== '' ? args.month.trim() : undefined
      const report = buildMonthlyReport(db, { month, timeZone: config.timeZone, today: today() })
      return {
        ok: true,
        month: report.month,
        ledger: report.ledger,
        wealth: report.wealth,
        comparison: report.comparison,
        rendered: report.rendered,
        // `text` is rendered as a second content block so the model can relay it verbatim.
        text: report.rendered,
      }
    },
  })

  registerJsonTool(ctx, {
    name: 'finance_alerts',
    description: '列出理财数据源 / 定时任务的失败告警（默认只返回未处理的）。',
    parameters: {
      include_resolved: { type: 'boolean', description: '是否包含已处理告警，默认 false' },
    },
    async execute(args) {
      const includeResolved = args.include_resolved === true
      const rows = db
        .prepare(
          `SELECT id, created_at, module, level, message, resolved FROM alerts
           ${includeResolved ? '' : 'WHERE resolved = 0'}
           ORDER BY created_at DESC, id DESC LIMIT 100`,
        )
        .all()
      return {
        ok: true,
        alerts: rows.map((row) => ({
          id: row.id,
          created_at: row.created_at,
          module: row.module,
          level: row.level,
          message: row.message,
          resolved: row.resolved === 1,
        })),
        total: rows.length,
        text:
          rows.length === 0
            ? '当前没有未处理的告警。'
            : rows.map((row) => `[${row.level}] ${row.created_at.slice(0, 19)} ${row.message}`).join('\n'),
      }
    },
  })

  registerJsonTool(ctx, {
    name: 'finance_status',
    description: '查看插件状态：数据库路径、初始余额是否已设置、账面笔数、理财持仓数、定时任务服务是否可用。',
    parameters: {},
    async execute() {
      const initialCents = getMetaInt(db, 'initial_balance_cents')
      const counts = {
        ledger_entries: countRows(db, TABLES.ledger[0]),
        wealth_products: countRows(db, TABLES.wealth[0]),
        wealth_daily_profit: countRows(db, TABLES.wealth[1]),
        monthly_reports: countRows(db, 'monthly_reports'),
        alerts: countRows(db, 'alerts'),
      }
      const lastRuns = db
        .prepare('SELECT job_key, status, ran_at FROM job_runs ORDER BY ran_at DESC LIMIT 10')
        .all()
      return {
        ok: true,
        db_path: dbPath,
        time_zone: config.timeZone,
        initial_balance_set: initialCents !== null,
        initial_balance_cents: initialCents,
        initial_balance_set_at: getMeta(db, 'initial_balance_set_at') ?? null,
        counts,
        last_job_runs: lastRuns.map((row) => ({ job_key: row.job_key, status: row.status, ran_at: row.ran_at })),
        schedule_available: Boolean(ctx.schedule),
        text:
          `数据库：${dbPath}｜时区：${config.timeZone}｜初始余额：${initialCents === null ? '未设置（记账前必须先设置）' : '已设置'}` +
          `\n记账 ${counts.ledger_entries} 笔 · 理财持仓 ${counts.wealth_products} 个 · 每日收益记录 ${counts.wealth_daily_profit} 条`,
      }
    },
  })
}

/** Re-exported for callers that need to fail loudly on an unsupported month. */
export function invalidMonth(month) {
  return fail(CODES.invalid_month, `月份必须是 YYYY-MM：${String(month)}`)
}
