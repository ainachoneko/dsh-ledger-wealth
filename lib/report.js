/**
 * Month-end report assembly.
 *
 * The report is deliberately two sections joined by a horizontal rule. Ledger
 * money (日常收支) and wealth money (理财收益/持仓) are read from separate tables
 * and rendered separately; no number in this file ever adds the two together.
 * @module dsh-ledger-wealth/report
 */

import { assertMonth, currentMonth, dateInZone, previousMonth } from './dates.js'
import { CODES, fail } from './errors.js'
import { getBalances, getMonthSummary } from './ledger.js'
import { formatCny, formatDeltaCny } from './money.js'
import { getWealthSummary } from './wealth.js'

/** Fixed divider between the two money worlds. */
export const SECTION_SEPARATOR = '------------------------------------------------------------'

const PRODUCT_TYPE_LABELS = {
  fund: '基金',
  bank_wealth: '银行理财',
  other: '其他',
}

const SOURCE_LABELS = {
  manual: '手动填写',
  api: '净值(API)',
  estimated: '涨跌幅估算',
  stale: '沿用上次值',
  sum: '累计求和',
  none: '无数据',
}

function typeLabel(type) {
  return PRODUCT_TYPE_LABELS[type] ?? type ?? '未知'
}

function sourceLabel(source) {
  return SOURCE_LABELS[source] ?? source ?? '未知'
}

/** Render the ledger section (no wealth number may enter this string). */
export function renderLedgerSection({ month, ledger, previousLedger, comparison, balance }) {
  const lines = ['## 一、记账部分（日常收支）']
  if (ledger.entry_count === 0) {
    lines.push('本月暂无记账记录。')
  } else {
    lines.push(`- 本月支出合计：${formatCny(ledger.expense_cents)}（${ledger.expense_entry_count} 笔）`)
    lines.push(`- 本月收入合计：${formatCny(ledger.income_cents)}（${ledger.income_entry_count} 笔）`)
    lines.push(`- 本月净结余：${formatCny(ledger.net_cents)}`)
    if (balance) lines.push(`- 当前可支配余额：${formatCny(balance.balance_cents)}（含全部历史收支）`)
    if (ledger.categories.length > 0) {
      lines.push('', '支出分类占比（前 5 类）：')
      lines.push('| 分类 | 金额 | 占比 |')
      lines.push('| --- | --- | --- |')
      for (const row of ledger.categories) {
        lines.push(`| ${row.category} | ${formatCny(row.expense_cents)} | ${row.share ?? '-'} |`)
      }
    }
    const largest = ledger.largest_expense
    if (largest) {
      // 商户与备注都贴在日期后面，金额始终紧挨分类——先「谁、什么时候」再「多少钱」。
      const who = [largest.merchant, largest.note].filter((part) => typeof part === 'string' && part.trim() !== '')
      const lead = who.length > 0 ? `${largest.date} ${who.join(' ')}` : largest.date
      lines.push('', `最大单笔支出：${lead} ${formatCny(largest.amount_cents)}（${largest.category}）`)
    }
  }
  if (previousLedger && comparison) {
    lines.push('')
    lines.push(
      `与上月对比（${previousMonth(month)}）：支出 ${formatDeltaCny(comparison.expense_delta_cents)}` +
        `（上月 ${formatCny(previousLedger.expense_cents)}）；收入 ${formatDeltaCny(comparison.income_delta_cents)}；` +
        `净结余 ${formatDeltaCny(comparison.net_delta_cents)}`,
    )
  } else {
    lines.push('', '与上月对比：上月无记账数据。')
  }
  return lines.join('\n')
}

/** Render the wealth section (no ledger number may enter this string). */
export function renderWealthSection({ wealth }) {
  const lines = ['## 二、理财部分（与日常记账分开）']
  const productCount = wealth.products.length
  if (productCount === 0) {
    lines.push('本月没有在持的理财产品。')
    return lines.join('\n')
  }
  const allManual = wealth.products.every((p) => p.total_profit_source === 'manual')
  lines.push(`- 持仓总金额：${formatCny(wealth.totals.holding_cents)}（${productCount} 个产品）`)
  lines.push(`- 持仓总收益：${formatCny(wealth.totals.total_profit_cents)}（来源：${sourceLabel(allManual ? 'manual' : 'sum')}）`)
  lines.push(
    `- 本月收益合计：${formatCny(wealth.totals.month_profit_cents)}` +
      `（仅统计 ${productCount - wealth.missing_product_count} 个有数据产品，缺失 ${wealth.missing_product_count} 个）`,
  )
  lines.push('', '各产品明细：')
  lines.push('| 产品 | 类型 | 持仓金额 | 本月收益 | 累计收益 | 数据来源 | 更新日期 |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- |')
  for (const product of wealth.products) {
    const latest = product.last_profit
    const source = sourceLabel(latest ? latest.source : 'none')
    const updated = latest ? latest.profit_date : '—'
    lines.push(
      `| ${product.product_name} | ${typeLabel(product.product_type)} | ${formatCny(product.holding_amount_cents)} |` +
        ` ${formatCny(product.month_profit_cents)} | ${formatCny(product.total_profit_cents)} | ${source} | ${updated} |`,
    )
  }
  lines.push('', '数据源说明：')
  if (wealth.missing_product_count === 0) {
    lines.push('- 本月所有产品均获取到收益数据。')
  } else {
    const names = wealth.missing_products
      .map((p) => `${p.product_name}（${p.reason ?? '数据源暂不可用'}）`)
      .join('、')
    lines.push(`- 数据源暂不可用的产品：${names}；其本月收益未计入合计。`)
  }
  const stale = wealth.products.filter((p) => p.stale && p.last_profit)
  if (stale.length > 0) {
    const names = stale
      .map((p) => `${p.product_name}（${p.last_profit.profit_date} 的 ${formatCny(p.last_profit.amount_cents)}）`)
      .join('、')
    lines.push(`- 以下数值为上次更新值，非今日实时数据：${names}`)
  }
  if (wealth.expiring.length > 0) {
    lines.push('', '到期提醒（7 天内）：')
    for (const item of wealth.expiring) {
      const when = item.days_left === 0 ? '今天到期' : `${item.days_left} 天后到期`
      lines.push(`- ${item.product_name}：${item.redeem_date}（${when}）`)
    }
  }
  return lines.join('\n')
}

/**
 * Build the full month-end report.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ month?: string, timeZone?: string, today?: string, now?: Date }} [options]
 */
export function buildMonthlyReport(db, options = {}) {
  const { timeZone = 'Asia/Shanghai', now = new Date() } = options
  const month = options.month ?? currentMonth(now, timeZone)
  try {
    assertMonth(month)
  } catch (error) {
    throw fail(CODES.invalid_month, `月份必须是 YYYY-MM：${String(options.month)}`, { detail: error.message })
  }
  const today = options.today ?? dateInZone(now, timeZone)
  const ledger = getMonthSummary(db, month)
  const previous = previousMonth(month)
  const previousLedger = getMonthSummary(db, previous)
  const hasPrevious = previousLedger.entry_count > 0
  const comparison = hasPrevious
    ? {
        expense_delta_cents: ledger.expense_cents - previousLedger.expense_cents,
        income_delta_cents: ledger.income_cents - previousLedger.income_cents,
        net_delta_cents: ledger.net_cents - previousLedger.net_cents,
      }
    : null
  const wealth = getWealthSummary(db, { month, today })
  let balance = null
  try {
    balance = getBalances(db)
  } catch {
    // No initial balance yet: the ledger section simply omits the balance line.
    balance = null
  }
  const ledgerText = renderLedgerSection({
    month,
    ledger,
    previousLedger: hasPrevious ? previousLedger : null,
    comparison,
    balance,
  })
  const wealthText = renderWealthSection({ wealth })
  const parts = [
    `# ${month} 月度报告`,
    `> 生成时间：${new Date(now).toISOString()} ｜ 记账与理财分属两个模块，金额互不合并计算`,
    '',
    ledgerText,
    '',
    SECTION_SEPARATOR,
    '',
    wealthText,
    '',
    '> 以上「日常收支」与「理财收益」为两个独立账本，不得相加。',
  ]
  return {
    month,
    generated_at: new Date(now).toISOString(),
    ledger,
    previous_ledger: hasPrevious ? previousLedger : null,
    comparison,
    wealth,
    ledger_text: ledgerText,
    wealth_text: wealthText,
    rendered: parts.join('\n'),
  }
}
