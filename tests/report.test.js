/**
 * Lead-owned report tests: the two money worlds stay in two sections, with a
 * fixed divider, and no total ever crosses modules.
 */

import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { CODES } from '../lib/errors.js'
import { recordEntry, setInitialBalance } from '../lib/ledger.js'
import { formatCny } from '../lib/money.js'
import { buildMonthlyReport, SECTION_SEPARATOR } from '../lib/report.js'
import { addProduct, recordDailyProfit } from '../lib/wealth.js'
import { registerReportTools } from '../lib/tools/report.js'
import { createMemoryDb, createTestContext, testConfig } from './helpers.js'

const TODAY = '2026-10-31'
const MONTH = '2026-10'

/** Ledger: 2 expenses + 1 income in October, 1 expense in September. */
function seedLedger(db) {
  setInitialBalance(db, { amountYuan: 5000, today: '2026-10-01' })
  recordEntry(db, { type: 'expense', amountYuan: 28, category: '餐饮', merchant: 'Manner', date: '2026-10-05' })
  recordEntry(db, { type: 'expense', amountYuan: 100, category: '交通', note: '打车', date: '2026-10-12' })
  recordEntry(db, { type: 'income', amountYuan: 12000, category: '工资', date: '2026-10-10' })
  recordEntry(db, { type: 'expense', amountYuan: 500, category: '购物', date: '2026-09-15' })
}

/** Wealth: one fund with data, one bank product without, one expiring fund. */
function seedWealth(db) {
  const a = addProduct(db, {
    product_name: '华夏成长混合',
    product_type: 'fund',
    identifier: '000001',
    holdingAmountYuan: 10000,
    shares: 5000,
    costNav: 2,
    today: TODAY,
  }).product
  recordDailyProfit(db, { productId: a.id, profitDate: '2026-10-30', amountCents: 500, source: 'manual' })

  addProduct(db, {
    product_name: '某银行理财',
    product_type: 'bank_wealth',
    identifier: 'CMB-2026-001',
    holdingAmountYuan: 20000,
    today: TODAY,
  })

  const c = addProduct(db, {
    product_name: '短期定开债基',
    product_type: 'fund',
    identifier: '110022',
    holdingAmountYuan: 5000,
    redeemDate: '2026-11-03',
    today: TODAY,
  }).product
  recordDailyProfit(db, { productId: c.id, profitDate: '2026-10-31', amountCents: 120, source: 'estimated' })
}

describe('monthly report', () => {
  /** @type {import('node:sqlite').DatabaseSync[]} */
  const opened = []
  afterEach(() => {
    while (opened.length > 0) {
      try {
        opened.pop().close()
      } catch {
        /* ignore */
      }
    }
  })
  function db() {
    const instance = createMemoryDb()
    opened.push(instance)
    return instance
  }

  it('separates the two money sections with a fixed divider', () => {
    const database = db()
    seedLedger(database)
    seedWealth(database)
    const report = buildMonthlyReport(database, { month: MONTH, today: TODAY })

    assert.equal(report.month, MONTH)
    assert.equal(report.ledger.expense_cents, 12800)
    assert.equal(report.ledger.income_cents, 1200000)
    assert.equal(report.ledger.net_cents, 1187200)
    assert.equal(report.ledger.entry_count, 3)
    assert.equal(report.wealth.totals.holding_cents, 3_500_000)

    // Both sections exist, in order, split by the exact separator.
    const ledgerAt = report.rendered.indexOf('## 一、记账部分（日常收支）')
    const wealthAt = report.rendered.indexOf('## 二、理财部分（与日常记账分开）')
    const sepAt = report.rendered.indexOf(SECTION_SEPARATOR)
    assert.ok(ledgerAt >= 0, 'ledger heading missing')
    assert.ok(wealthAt > ledgerAt, 'wealth heading must come after the ledger heading')
    assert.ok(sepAt > ledgerAt && sepAt < wealthAt, 'separator must sit between the sections')

    // The ledger text never mentions a wealth total, and vice versa.
    assert.doesNotMatch(report.ledger_text, /持仓总金额|本月收益合计/)
    assert.doesNotMatch(report.wealth_text, /本月支出合计|本月收入合计|当前可支配余额/)
    assert.match(report.ledger_text, new RegExp(formatCny(12800).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.match(report.wealth_text, /持仓总金额：¥35,000\.00/)
  })

  it('renders running balance and month-over-month comparison', () => {
    const database = db()
    seedLedger(database)
    const report = buildMonthlyReport(database, { month: MONTH, today: TODAY })

    // 5000 + 12000 - 128 - 500(September) = 16372.00: the running balance is all-history.
    assert.equal(report.comparison.expense_delta_cents, 12800 - 50000)
    assert.equal(report.comparison.income_delta_cents, 1200000)
    assert.equal(report.comparison.net_delta_cents, 1187200 + 50000)
    assert.match(report.ledger_text, /当前可支配余额：¥16,372\.00/)
    assert.match(report.ledger_text, /与上月对比（2026-09）/)
    assert.match(report.ledger_text, /支出 -¥372\.00/)
  })

  it('lists top categories and the largest single expense', () => {
    const database = db()
    seedLedger(database)
    const report = buildMonthlyReport(database, { month: MONTH, today: TODAY })
    const categories = report.ledger.categories
    assert.equal(categories.length, 2)
    assert.equal(categories[0].category, '交通')
    assert.equal(categories[0].expense_cents, 10000)
    assert.equal(categories[0].share, '78.1%')
    assert.equal(report.ledger.largest_expense.amount_cents, 10000)
    assert.match(report.ledger_text, /最大单笔支出：2026-10-12 打车/)
  })

  it('reports an empty month without inventing numbers', () => {
    const database = db()
    setInitialBalance(database, { amountYuan: 100, today: TODAY })
    const report = buildMonthlyReport(database, { month: '2026-07', today: TODAY })
    assert.equal(report.ledger.entry_count, 0)
    assert.match(report.rendered, /本月暂无记账记录/)
    assert.match(report.rendered, /本月没有在持的理财产品/)
    assert.match(report.rendered, /上月无记账数据/)
    assert.equal(report.comparison, null)
  })

  it('marks missing, stale and expiring wealth data', () => {
    const database = db()
    seedWealth(database)
    const staleProduct = addProduct(database, {
      product_name: '长期未更新的债基',
      product_type: 'fund',
      identifier: '003003',
      holdingAmountYuan: 8000,
      today: TODAY,
    }).product
    recordDailyProfit(database, {
      productId: staleProduct.id,
      profitDate: '2026-10-20',
      amountCents: 250,
      source: 'manual',
    })

    const report = buildMonthlyReport(database, { month: MONTH, today: TODAY })
    assert.equal(report.wealth.missing_product_count, 1)
    assert.equal(report.wealth.missing_products[0].product_name, '某银行理财')
    assert.match(report.wealth.missing_products[0].reason, /银行理财/)

    const byName = Object.fromEntries(report.wealth.products.map((p) => [p.product_name, p]))
    assert.equal(byName['长期未更新的债基'].stale, true)
    assert.equal(byName['华夏成长混合'].stale, false)

    assert.deepEqual(
      report.wealth.expiring.map((item) => [item.product_name, item.days_left]),
      [['短期定开债基', 3]],
    )
    assert.match(report.wealth_text, /到期提醒（7 天内）/)
    assert.match(report.wealth_text, /3 天后到期/)
    assert.match(report.wealth_text, /以下数值为上次更新值，非今日实时数据/)
    assert.match(report.wealth_text, /数据源暂不可用的产品/)
    assert.match(report.wealth_text, /缺失 1 个/)
  })

  it('rejects an invalid month with a stable code', () => {
    const database = db()
    assert.throws(
      () => buildMonthlyReport(database, { month: '2026-13', today: TODAY }),
      (error) => error.code === CODES.invalid_month,
    )
  })

  it('exposes the report through the read-only tool layer', async () => {
    const database = db()
    seedLedger(database)
    seedWealth(database)
    const { ctx, call, definitions } = createTestContext()
    registerReportTools(ctx, {
      db: database,
      config: testConfig(),
      dbPath: ':memory:',
      today: () => TODAY,
    })
    assert.deepEqual([...definitions.keys()].sort(), ['finance_alerts', 'finance_monthly_report', 'finance_status'])

    const result = await call('finance_monthly_report', { month: MONTH })
    assert.equal(result.ok, true)
    assert.equal(result.month, MONTH)
    assert.equal(result.ledger.expense_cents, 12800)
    assert.equal(result.text, result.rendered)
    assert.match(result.text, /## 二、理财部分（与日常记账分开）/)

    // Rendering yields the JSON block plus the human-readable report.
    const blocks = definitions.get('finance_monthly_report').output.render({ month: MONTH }, result)
    assert.equal(blocks.length, 2)
    assert.equal(blocks[1].text, result.rendered)

    const alerts = await call('finance_alerts', {})
    assert.equal(alerts.ok, true)
    assert.equal(alerts.total, 0)

    const status = await call('finance_status', {})
    assert.equal(status.ok, true)
    assert.equal(status.initial_balance_set, true)
    assert.equal(status.counts.ledger_entries, 4)
    assert.equal(status.counts.wealth_products, 3)
  })

  it('does not write a report when merely read', async () => {
    const database = db()
    seedLedger(database)
    const { ctx, call } = createTestContext()
    registerReportTools(ctx, { db: database, config: testConfig(), dbPath: ':memory:', today: () => TODAY })
    await call('finance_monthly_report', { month: MONTH })
    await call('finance_monthly_report', { month: MONTH })
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM monthly_reports').get().n, 0)
  })
})
