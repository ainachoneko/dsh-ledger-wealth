/**
 * B 模块（理财）测试：降级链、确认两步、幂等、与记账的金额隔离。
 *
 * 全部用内存库；基金快照用假的 `fetchImpl` 喂固定文本，不联网。
 * 日期一律显式传入（TODAY / '2026-10-30'），不依赖系统时钟。
 */

import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { openDb } from '../lib/db.js'
import { fundProfitOf, refreshDailyProfits, resolveDailyProfit } from '../lib/profit.js'
import { addProduct, listProducts, recordDailyProfit } from '../lib/wealth.js'
import { registerWealthTools } from '../lib/tools/wealth.js'
import { createTestContext, testConfig } from './helpers.js'

const TODAY = '2026-10-31'
const PROFIT_DAY = '2026-10-30'

/** 打开一个内存库，用例结束自动关闭。 */
function freshDb(t) {
  const db = openDb(':memory:')
  t.after(() => db.close())
  return db
}

/** 造一份东财 pingzhongdata 文本（两个交易日的真实净值）。 */
function pingzhongText({ prevNav = 2.0, nav = 2.01, changePct = 0.5 } = {}) {
  const prevX = Date.UTC(2026, 9, 29, 1)
  const lastX = Date.UTC(2026, 9, 30, 1)
  const points = [
    `{x:${prevX},y:${prevNav},equityReturn:0}`,
    `{x:${lastX},y:${nav},equityReturn:${changePct}}`,
  ]
  return `var fS_name = "华夏成长混合";var fS_code = "000001";var Data_netWorthTrend = [${points.join(',')}];`
}

/** 假的 fetch：任何 URL 都返回同一段文本。 */
function fakeFetch(text) {
  return async () => ({ ok: true, status: 200, text: async () => text })
}

/** 注册理财工具到假 ctx。 */
function setupTools(db) {
  const env = createTestContext()
  registerWealthTools(env.ctx, { db, config: testConfig(), today: () => TODAY })
  return env
}

describe('profit fallback chain', () => {
  const opened = []
  afterEach(() => {
    while (opened.length > 0) opened.pop().close()
  })
  function db() {
    const instance = openDb(':memory:')
    opened.push(instance)
    return instance
  }

  it('uses the real NAV difference when shares and both NAVs are known', async () => {
    const database = db()
    const { product } = addProduct(database, {
      product_name: '华夏成长混合',
      product_type: 'fund',
      identifier: '000001',
      holdingAmountYuan: 10000,
      shares: 5000,
      today: TODAY,
    })

    const resolved = await resolveDailyProfit({
      product,
      profitDate: PROFIT_DAY,
      config: testConfig(),
      fetchImpl: fakeFetch(pingzhongText({ prevNav: 2.0, nav: 2.01, changePct: 0.5 })),
    })

    assert.equal(resolved.status, 'ok')
    assert.equal(resolved.profit.source, 'api')
    // 5000 份 × (2.01 − 2.00) = 50 元 = 5000 分
    assert.equal(resolved.profit.amount_cents, 5000)
    assert.equal(resolved.profit.nav_date, PROFIT_DAY)
    assert.match(resolved.profit.detail, /单位净值/)
  })

  it('falls back to an explicit estimate when the share count is missing', async () => {
    const database = db()
    const { product } = addProduct(database, {
      product_name: '无份额债基',
      product_type: 'fund',
      identifier: '110022',
      holdingAmountYuan: 10000,
      today: TODAY,
    })

    const resolved = await resolveDailyProfit({
      product,
      profitDate: PROFIT_DAY,
      config: testConfig(),
      fetchImpl: fakeFetch(pingzhongText({ prevNav: 1.2, nav: 1.218, changePct: 1.5 })),
    })

    assert.equal(resolved.status, 'ok')
    assert.equal(resolved.profit.source, 'estimated', '估算值必须标成 estimated，不能冒充官方收益')
    // 1,000,000 分 × 1.5% = 15,000 分
    assert.equal(resolved.profit.amount_cents, 15000)
    assert.match(resolved.profit.detail, /估算/)
  })

  it('never invents a number from an annualized rate', () => {
    // 只有单位净值、没有上一交易日净值、没有涨跌幅 → 必须拒绝计算，而不是拿年化 ÷ 365。
    const product = { identifier: '000001', shares: null, holding_amount_cents: 1000000 }
    assert.equal(fundProfitOf(product, { unitNav: 2.0, prevUnitNav: null, changePct: null }), null)
  })

  it('carries the last known value forward for bank products and marks it stale', async () => {
    const database = db()
    const { product } = addProduct(database, {
      product_name: '某银行理财',
      product_type: 'bank_wealth',
      identifier: 'CMB-2026-001',
      holdingAmountYuan: 20000,
      today: TODAY,
    })
    recordDailyProfit(database, { productId: product.id, profitDate: '2026-10-29', amountCents: 88, source: 'manual' })

    const resolved = await resolveDailyProfit({
      product,
      profitDate: PROFIT_DAY,
      config: testConfig(),
      latestProfit: { profit_date: '2026-10-29', amount_cents: 88, source: 'manual' },
    })

    assert.equal(resolved.status, 'ok')
    assert.equal(resolved.profit.source, 'stale')
    assert.equal(resolved.profit.amount_cents, 88)
    assert.match(resolved.profit.detail, /非实时/)
    assert.ok(resolved.attempts.some((attempt) => attempt.source === 'bank' && attempt.reason === 'not_covered'))
  })

  it('reports unavailable when nothing works and there is no history', async () => {
    const database = db()
    const { product } = addProduct(database, {
      product_name: '其他类产品',
      product_type: 'other',
      identifier: 'MISC-1',
      holdingAmountYuan: 5000,
      today: TODAY,
    })
    const resolved = await resolveDailyProfit({ product, profitDate: PROFIT_DAY, config: testConfig() })
    assert.equal(resolved.status, 'unavailable')
    assert.equal(resolved.profit, null)
    assert.equal(resolved.reason, 'not_covered')
  })

  it('records what it can and alerts only when every product failed', async () => {
    const database = db()
    const manual = addProduct(database, {
      product_name: '天天盈',
      product_type: 'other',
      identifier: 'MISC-2',
      holdingAmountYuan: 8000,
      manualDailyProfitYuan: 0.18,
      today: TODAY,
    }).product
    const bank = addProduct(database, {
      product_name: '某银行理财',
      product_type: 'bank_wealth',
      identifier: 'CMB-2026-002',
      holdingAmountYuan: 20000,
      today: TODAY,
    }).product

    const partial = await refreshDailyProfits(database, { profitDate: PROFIT_DAY, config: testConfig() })
    assert.equal(partial.updated.length, 1)
    assert.equal(partial.updated[0].product_id, manual.id)
    assert.equal(partial.updated[0].source, 'manual')
    assert.equal(partial.updated[0].amount_cents, 18)
    assert.deepEqual(
      partial.missing.map((item) => item.product_id),
      [bank.id],
    )
    assert.equal(partial.all_failed, false)

    // 只有银行产品时：全失败，必须给一条 warning，而不是静默返回 0 收益。
    const onlyBank = openDb(':memory:')
    try {
      addProduct(onlyBank, {
        product_name: '只剩银行理财',
        product_type: 'bank_wealth',
        identifier: 'CMB-2026-003',
        holdingAmountYuan: 10000,
        today: TODAY,
      })
      const failed = await refreshDailyProfits(onlyBank, { profitDate: PROFIT_DAY, config: testConfig() })
      assert.equal(failed.all_failed, true)
      assert.equal(failed.updated.length, 0)
      assert.equal(failed.alerts.length, 1)
      assert.equal(failed.alerts[0].level, 'warning')
      assert.match(failed.alerts[0].message, /数据源暂不可用/)
    } finally {
      onlyBank.close()
    }
  })

  it('is idempotent: rerunning the same day overwrites instead of duplicating', async () => {
    const database = db()
    const { product } = addProduct(database, {
      product_name: '华夏成长混合',
      product_type: 'fund',
      identifier: '000001',
      holdingAmountYuan: 10000,
      shares: 5000,
      today: TODAY,
    })
    const options = {
      profitDate: PROFIT_DAY,
      config: testConfig(),
      fetchImpl: fakeFetch(pingzhongText({ prevNav: 2.0, nav: 2.01, changePct: 0.5 })),
    }
    await refreshDailyProfits(database, options)
    await refreshDailyProfits(database, options)
    const rows = database.prepare('SELECT COUNT(*) AS n FROM wealth_daily_profit WHERE product_id = ?').get(product.id)
    assert.equal(Number(rows.n), 1)
  })
})

describe('wealth tools', () => {
  it('previews a product without writing, then records it after confirmation', async (t) => {
    const database = freshDb(t)
    const tools = setupTools(database)
    const args = {
      product_name: '华夏成长混合',
      product_type: 'fund',
      identifier: '000001',
      holding_amount: 10000,
      shares: 5000,
    }

    const preview = await tools.call('wealth_add_product', args)
    assert.equal(preview.ok, true)
    assert.equal(preview.status, 'needs_confirmation')
    assert.match(preview.message, /待确认/)
    assert.equal(listProducts(database, { active: null }).products.length, 0, '预览绝不能落库')

    const recorded = await tools.call('wealth_add_product', { ...args, confirm: true })
    assert.equal(recorded.status, 'recorded')
    assert.equal(recorded.product.identifier, '000001')
    assert.equal(recorded.product.holding_amount_cents, 1000000)
    assert.equal(listProducts(database, { active: null }).products.length, 1)
  })

  it('rejects a duplicate product with a stable code', async (t) => {
    const database = freshDb(t)
    const tools = setupTools(database)
    const args = {
      product_name: '华夏成长混合',
      product_type: 'fund',
      identifier: '000001',
      holding_amount: 10000,
      confirm: true,
    }
    await tools.call('wealth_add_product', args)
    const again = await tools.call('wealth_add_product', args)
    assert.equal(again.ok, false)
    assert.equal(again.code, 'duplicate_product')
  })

  it('never mixes wealth numbers into ledger words (or the other way round)', async (t) => {
    const database = freshDb(t)
    const tools = setupTools(database)
    await tools.call('wealth_add_product', {
      product_name: '华夏成长混合',
      product_type: 'fund',
      identifier: '000001',
      holding_amount: 10000,
      shares: 5000,
      confirm: true,
    })
    const summary = await tools.call('wealth_summary', { month: '2026-10' })
    assert.equal(summary.ok, true)
    assert.equal(summary.summary.totals.holding_cents, 1000000)
    assert.doesNotMatch(summary.text, /结余|支出合计|收入合计|当前可支配余额/)
    // 汇总 JSON 里不允许出现记账字段
    const keys = Object.keys(summary.summary)
    assert.equal(keys.includes('ledger'), false)
    assert.equal(keys.includes('net_cents'), false)
  })

  it('records a manual profit idempotently and reports the replacement', async (t) => {
    const database = freshDb(t)
    const tools = setupTools(database)
    const { product } = await tools.call('wealth_add_product', {
      product_name: '天天盈',
      product_type: 'other',
      identifier: 'MISC-9',
      holding_amount: 8000,
      confirm: true,
    })

    const first = await tools.call('wealth_record_profit', {
      product_id: product.id,
      amount: 0.18,
      profit_date: PROFIT_DAY,
      confirm: true,
    })
    assert.equal(first.status, 'recorded')
    assert.equal(first.profit.amount_cents, 18)

    const second = await tools.call('wealth_record_profit', {
      product_id: product.id,
      amount: 0.2,
      profit_date: PROFIT_DAY,
      confirm: true,
    })
    assert.equal(second.status, 'replaced')
    assert.equal(second.profit.amount_cents, 20)
    const rows = database.prepare('SELECT COUNT(*) AS n FROM wealth_daily_profit').get()
    assert.equal(Number(rows.n), 1)
  })

  it('lists holdings without pretending archived ones are still held', async (t) => {
    const database = freshDb(t)
    const tools = setupTools(database)
    const { product } = await tools.call('wealth_add_product', {
      product_name: '华夏成长混合',
      product_type: 'fund',
      identifier: '000001',
      holding_amount: 10000,
      confirm: true,
    })
    await tools.call('wealth_update_product', { id: product.id, active: false, confirm: true })

    const active = await tools.call('wealth_list_products', {})
    assert.equal(active.count, 0)
    const all = await tools.call('wealth_list_products', { include_archived: true })
    assert.equal(all.count, 1)
  })
})
