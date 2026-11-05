/**
 * 收益解析：理财「昨日收益」的严格降级链。
 *
 * 顺序固定，每一步都记进 `attempts`，绝不跳步、绝不编造：
 *   1. `manual`       —— 用户手填的当日收益，最可信；
 *   2. `api`          —— 基金真实净值差：`shares × (今日单位净值 − 上一交易日单位净值)`；
 *   3. `estimated`    —— 只有涨跌幅、拿不到净值差或份额时，用 `持仓金额 × 涨跌幅` 估算，**必须标 estimated**；
 *   4. `not_covered`  —— 银行理财暂无免费源，直接不可用（不爬登录态页面）；
 *   5. `stale`        —— 以上全失败时沿用上一次记录，`detail` 写明「非实时」；
 *   6. `unavailable`  —— 连历史值都没有，返回空收益并计入 missing，不落库。
 *
 * 硬约束：**禁止用「年化收益率 ÷ 365」推算任何数字**；七日年化只用于展示，不参与收益计算。
 * @module dsh-ledger-wealth/profit
 */

import { addDays, assertDate } from './dates.js'
import { CODES, fail } from './errors.js'
import { fetchBankSnapshot } from './sources/bank.js'
import { fetchFundSnapshot } from './sources/fund.js'
import { getLatestProfit, listProducts, recordDailyProfit } from './wealth.js'

/** 一天有多少分（整数分换算用）。 */
const CENTS_PER_YUAN = 100

/** 日期参数校验：TypeError -> invalid_date。 */
function requireDate(value, field) {
  try {
    return assertDate(value, field)
  } catch (error) {
    throw fail(CODES.invalid_date, `${field} 必须是真实日期（YYYY-MM-DD）：${String(value)}`, {
      field,
      detail: error instanceof Error ? error.message : String(error),
    })
  }
}

/** 金额分必须是安全整数；null/undefined/空串视为「没有值」，不能当成 0。 */
function centsOf(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isSafeInteger(n) ? n : null
}

/** 数值字段：缺失或非有限值一律 null（`Number(null) === 0` 是这里最容易踩的坑）。 */
function numOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/**
 * 由基金快照算出一笔真实收益。
 *
 * 优先用真实净值差（含分红前的口径问题不存在于单位净值差里，但涨跌幅会更稳），
 * 拿不到净值差或份额时退回涨跌幅估算，并把 source 降到 `estimated`。
 * @param {object} product 序列化后的理财产品
 * @param {object} data fetchFundSnapshot 的 data
 * @returns {{amount_cents:number, source:'api'|'estimated', nav_date:string|null, detail:string}|null}
 */
export function fundProfitOf(product, data) {
  if (!data || typeof data !== 'object') return null
  const name = typeof data.name === 'string' && data.name !== '' ? data.name : product.identifier
  const shares = numOrNull(product.shares)
  const unitNav = numOrNull(data.unitNav)
  const prevUnitNav = numOrNull(data.prevUnitNav)
  const navDate = typeof data.navDate === 'string' ? data.navDate : null

  // 2. 真实净值差：份额 ×（今日 − 上一交易日），这是唯一能叫「实际收益」的算法。
  if (shares !== null && shares > 0 && unitNav !== null && prevUnitNav !== null) {
    const deltaCents = Math.round(shares * (unitNav - prevUnitNav) * CENTS_PER_YUAN)
    return {
      amount_cents: deltaCents,
      source: 'api',
      nav_date: navDate,
      detail: `${name} 单位净值 ${prevUnitNav} → ${unitNav}（${navDate ?? '净值日未知'}），份额 ${shares}`,
    }
  }

  // 3. 只有涨跌幅：按持仓金额估算，明确标 estimated，不能当官方收益。
  const changePct = numOrNull(data.changePct)
  const holding = numOrNull(product.holding_amount_cents)
  if (changePct !== null && holding !== null) {
    return {
      amount_cents: Math.round((holding * changePct) / 100),
      source: 'estimated',
      nav_date: navDate,
      detail: `${name} 仅有涨跌幅 ${changePct}%，按持仓金额 ${holding} 分估算（估算值，非官方收益）`,
    }
  }
  return null
}

/**
 * 解析一个产品某天的收益（不落库）。
 * @param {{
 *   product: object,
 *   profitDate: string,
 *   config?: object,
 *   fetchImpl?: typeof fetch,
 *   signal?: AbortSignal,
 *   latestProfit?: object|null,
 * }} options
 * @returns {Promise<{
 *   status:'ok'|'unavailable',
 *   profit: { amount_cents:number, source:'manual'|'api'|'estimated'|'stale', nav_date:string|null, detail:string }|null,
 *   reason: string|null,
 *   attempts: Array<{source:string, ok:boolean, reason:string|null, detail?:string|undefined}>,
 * }>}
 */
export async function resolveDailyProfit({
  product,
  profitDate,
  config = {},
  fetchImpl = fetch,
  signal,
  latestProfit = null,
} = {}) {
  if (!product || typeof product !== 'object') {
    throw fail(CODES.invalid_argument, 'resolveDailyProfit 需要 product', { field: 'product' })
  }
  const day = requireDate(profitDate, 'profitDate')
  const timeoutMs = Number(config.fetchTimeoutMs) > 0 ? Number(config.fetchTimeoutMs) : 8000
  /** @type {Array<{source:string, ok:boolean, reason:string|null, detail?:string|undefined}>} */
  const attempts = []

  // 1. 手动填写的当日收益。
  const manualCents = centsOf(product.manual_daily_profit_cents)
  if (manualCents !== null) {
    return {
      status: 'ok',
      profit: { amount_cents: manualCents, source: 'manual', nav_date: day, detail: '用户手动填写的当日收益' },
      reason: null,
      attempts: [{ source: 'manual', ok: true, reason: null }],
    }
  }
  attempts.push({ source: 'manual', ok: false, reason: 'not_set' })

  // 2/3. 基金：真实净值差优先，涨跌幅兜底。
  if (product.product_type === 'fund') {
    if (config.fundApiEnabled === false) {
      attempts.push({ source: 'fund', ok: false, reason: 'disabled', detail: '配置里关闭了基金数据源' })
    } else {
      const snapshot = await fetchFundSnapshot(product.identifier, { timeoutMs, fetchImpl, signal })
      if (snapshot.ok) {
        const computed = fundProfitOf(product, snapshot.data)
        if (computed) {
          attempts.push({ source: 'fund', ok: true, reason: null })
          return { status: 'ok', profit: computed, reason: null, attempts }
        }
        attempts.push({
          source: 'fund',
          ok: false,
          reason: 'no_nav_difference',
          detail: '净值数据不足以算出真实收益（缺份额或上一交易日净值）',
        })
      } else {
        attempts.push({ source: 'fund', ok: false, reason: snapshot.reason, detail: snapshot.detail })
      }
    }
  } else if (product.product_type === 'bank_wealth') {
    // 4. 银行理财：明确「无免费源」，不允许硬爬。
    if (config.bankApiEnabled === false) {
      attempts.push({ source: 'bank', ok: false, reason: 'disabled', detail: '配置里关闭了银行数据源' })
    } else {
      const snapshot = await fetchBankSnapshot(product.identifier, { timeoutMs, signal })
      attempts.push({
        source: 'bank',
        ok: Boolean(snapshot.ok),
        reason: snapshot.ok ? null : snapshot.reason,
        detail: snapshot.ok ? undefined : snapshot.detail,
      })
    }
  } else {
    attempts.push({ source: 'source', ok: false, reason: 'not_covered', detail: '该类型产品没有可用的数据源' })
  }

  // 5. 沿用上一次记录（明确标注非实时），而不是编一个数字。
  const staleCents = centsOf(latestProfit?.amount_cents)
  if (staleCents !== null && typeof latestProfit?.profit_date === 'string') {
    return {
      status: 'ok',
      profit: {
        amount_cents: staleCents,
        source: 'stale',
        nav_date: latestProfit.profit_date,
        detail: `沿用 ${latestProfit.profit_date} 的数据（来源 ${latestProfit.source ?? 'unknown'}），非实时`,
      },
      reason: 'stale',
      attempts,
    }
  }

  // 6. 没有任何可用数据。
  const lastFailure = attempts[attempts.length - 1]
  return {
    status: 'unavailable',
    profit: null,
    reason: lastFailure?.reason ?? 'unavailable',
    attempts,
  }
}

/**
 * 刷新一批产品的当日收益并落库（幂等：同日重跑覆盖同一行）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{profitDate:string, config?:object, fetchImpl?:typeof fetch, signal?:AbortSignal}} options
 * @returns {Promise<{
 *   profit_date: string,
 *   updated: Array<{product_id:string, product_name:string, amount_cents:number, source:string, nav_date:string|null}>,
 *   missing: Array<{product_id:string, product_name:string, reason:string}>,
 *   alerts: Array<{level:'info'|'warning'|'error', message:string}>,
 *   all_failed: boolean,
 * }>}
 */
export async function refreshDailyProfits(db, { profitDate, config = {}, fetchImpl = fetch, signal } = {}) {
  if (!db || typeof db.prepare !== 'function') {
    throw fail(CODES.invalid_argument, 'refreshDailyProfits 需要 db', { field: 'db' })
  }
  const day = requireDate(profitDate, 'profitDate')
  const { products } = listProducts(db, { active: true })

  const updated = []
  const missing = []

  for (const product of products) {
    // 「上一次」必须严格早于目标日，否则重跑会把当天自己的值当成历史值。
    const previous = getLatestProfit(db, product.id, { onOrBefore: addDays(day, -1) })
    let resolved
    try {
      resolved = await resolveDailyProfit({ product, profitDate: day, config, fetchImpl, signal, latestProfit: previous })
    } catch (error) {
      resolved = {
        status: 'unavailable',
        profit: null,
        reason: 'internal_error',
        attempts: [],
      }
      resolved.detail = error instanceof Error ? error.message : String(error)
    }

    if (resolved.status === 'ok' && resolved.profit) {
      const { amount_cents: amountCents, source, nav_date: navDate, detail } = resolved.profit
      recordDailyProfit(db, {
        productId: product.id,
        profitDate: day,
        amountCents,
        source,
        navDate,
        detail,
      })
      updated.push({
        product_id: product.id,
        product_name: product.product_name,
        amount_cents: amountCents,
        source,
        nav_date: navDate ?? null,
      })
    } else {
      missing.push({
        product_id: product.id,
        product_name: product.product_name,
        reason: resolved.detail ? `${resolved.reason ?? 'unavailable'}（${resolved.detail}）` : (resolved.reason ?? 'unavailable'),
      })
    }
  }

  const alerts = []
  const allFailed = products.length > 0 && updated.length === 0
  if (allFailed) {
    const detail = missing.map((item) => `${item.product_name}（${item.reason}）`).join('；')
    alerts.push({ level: 'warning', message: `理财数据源暂不可用，今日没有任何产品取到收益：${detail}` })
  } else if (missing.length > 0) {
    const detail = missing.map((item) => `${item.product_name}（${item.reason}）`).join('；')
    alerts.push({ level: 'info', message: `有 ${missing.length} 个产品今日没有可用收益数据：${detail}` })
  }

  return { profit_date: day, updated, missing, alerts, all_failed: allFailed }
}
