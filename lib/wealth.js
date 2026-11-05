/**
 * B 模块持久化与汇总：理财持仓（wealth_products）与每日收益（wealth_daily_profit）。
 *
 * 硬约束：
 * - 金额落库一律整数分（`*_cents`），对外 JSON 才转元（两位小数）；
 * - 理财与记账物理隔离，本模块只读写 `wealth_*` 表，绝不与记账金额相加；
 * - 输入校验失败抛 `LedgerError`（稳定错误码），由工具层统一 `toToolError`。
 * @module dsh-ledger-wealth/wealth
 */

import { addDays, assertDate, assertMonth, dateInZone, daysBetween, monthKeyOf, monthRange, nowIso } from './dates.js'
import { newId } from './db.js'
import { CODES, fail } from './errors.js'
import { fromCents, optionalSignedCents, toPositiveCents, toSignedCents } from './money.js'

/** 产品类型枚举（与数据库 CHECK 一致）。 */
export const PRODUCT_TYPES = ['fund', 'bank_wealth', 'other']

/** 收益来源枚举（与数据库 CHECK 一致）。 */
export const PROFIT_SOURCES = ['manual', 'api', 'estimated', 'stale']

/** 数字型字段（元）统一走这里，把 money.js 的 TypeError 换成稳定错误码。 */
function centsField(value, field, { positive = false } = {}) {
  try {
    return positive ? toPositiveCents(value, field) : toSignedCents(value, field)
  } catch (error) {
    throw fail(CODES.invalid_amount, `${field} 金额不合法：${error.message}`, { field })
  }
}

/** 可选金额（元 -> 分），null/'' -> null。 */
function optionalCentsField(value, field) {
  try {
    return optionalSignedCents(value, field)
  } catch (error) {
    throw fail(CODES.invalid_amount, `${field} 金额不合法：${error.message}`, { field })
  }
}

/** 日期字段校验，TypeError -> invalid_date。 */
function dateField(value, field) {
  try {
    return assertDate(value, field)
  } catch (error) {
    throw fail(CODES.invalid_date, `${field} 日期不合法：${error.message}`, { field })
  }
}

/** 非空文本字段。 */
function textField(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw fail(CODES.invalid_argument, `${field} 必须是非空字符串`, { field })
  }
  return value.trim()
}

/** 可选正数（份额 / 成本净值，不是金额分）。 */
function optionalPositiveNumber(value, field) {
  if (value === undefined || value === null || value === '') return null
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) throw fail(CODES.invalid_argument, `${field} 必须是大于 0 的数字`, { field })
  return n
}

/** 排序后的产品行 -> 对外 JSON（元；日期字符串；null 保留）。 */
export function serializeProduct(row) {
  if (!row) return null
  return {
    id: row.id,
    product_name: row.product_name,
    product_type: row.product_type,
    identifier: row.identifier,
    holding_amount_cents: row.holding_amount_cents,
    holding_amount: fromCents(row.holding_amount_cents),
    shares: row.shares ?? null,
    cost_nav: row.cost_nav ?? null,
    manual_daily_profit_cents: row.manual_daily_profit_cents ?? null,
    manual_daily_profit:
      row.manual_daily_profit_cents === null || row.manual_daily_profit_cents === undefined
        ? null
        : fromCents(row.manual_daily_profit_cents),
    manual_total_profit_cents: row.manual_total_profit_cents ?? null,
    manual_total_profit:
      row.manual_total_profit_cents === null || row.manual_total_profit_cents === undefined
        ? null
        : fromCents(row.manual_total_profit_cents),
    buy_date: row.buy_date ?? null,
    redeem_date: row.redeem_date ?? null,
    active: Boolean(row.active),
    last_updated: row.last_updated,
    created_at: row.created_at,
  }
}

/** 按 id 读取原始数据库行。 */
function getRowById(db, id) {
  return db.prepare('SELECT * FROM wealth_products WHERE id = ?').get(id) ?? null
}

/** 按 (product_type, identifier) 读取原始行。 */
function getRowByIdentifier(db, productType, identifier) {
  return (
    db
      .prepare('SELECT * FROM wealth_products WHERE product_type = ? AND identifier = ?')
      .get(productType, identifier) ?? null
  )
}

/**
 * 新增理财产品。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{
 *   product_name: string, product_type: string, identifier: string,
 *   holdingAmountYuan: number, shares?: number|null, costNav?: number|null,
 *   manualDailyProfitYuan?: number|null, manualTotalProfitYuan?: number|null,
 *   buyDate?: string|null, redeemDate?: string|null, today?: string,
 * }} payload
 * @returns {{ product: object }}
 */
export function addProduct(db, payload = {}) {
  const productName = textField(payload.product_name, 'product_name')
  const productType = payload.product_type
  if (!PRODUCT_TYPES.includes(productType)) {
    throw fail(CODES.invalid_type, `product_type 必须是 ${PRODUCT_TYPES.join(' | ')}`, { field: 'product_type' })
  }
  const identifier = textField(payload.identifier, 'identifier')
  if (productType === 'fund' && !/^\d{6}$/.test(identifier)) {
    throw fail(CODES.invalid_argument, '基金代码必须是 6 位数字', { field: 'identifier' })
  }
  const holdingAmountCents = centsField(payload.holdingAmountYuan, 'holding_amount', { positive: true })
  const shares = optionalPositiveNumber(payload.shares, 'shares')
  const costNav = optionalPositiveNumber(payload.costNav, 'cost_nav')
  const manualDailyProfitCents = optionalCentsField(payload.manualDailyProfitYuan, 'manual_daily_profit')
  const manualTotalProfitCents = optionalCentsField(payload.manualTotalProfitYuan, 'manual_total_profit')
  const buyDate = payload.buyDate === undefined || payload.buyDate === null || payload.buyDate === ''
    ? null
    : dateField(payload.buyDate, 'buy_date')
  const redeemDate = payload.redeemDate === undefined || payload.redeemDate === null || payload.redeemDate === ''
    ? null
    : dateField(payload.redeemDate, 'redeem_date')
  if (buyDate && redeemDate && daysBetween(buyDate, redeemDate) < 0) {
    throw fail(CODES.invalid_date, 'redeem_date 不能早于 buy_date', { field: 'redeem_date' })
  }
  const today = payload.today ? dateField(payload.today, 'today') : dateInZone(new Date())

  if (getRowByIdentifier(db, productType, identifier)) {
    throw fail(CODES.duplicate_product, `已存在相同产品：${productType} / ${identifier}`, {
      product_type: productType,
      identifier,
    })
  }

  const id = newId('product')
  const stamp = nowIso()
  db.prepare(
    `INSERT INTO wealth_products (
       id, product_name, product_type, identifier, holding_amount_cents, shares, cost_nav,
       manual_daily_profit_cents, manual_total_profit_cents, buy_date, redeem_date, active,
       last_updated, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(
    id,
    productName,
    productType,
    identifier,
    holdingAmountCents,
    shares,
    costNav,
    manualDailyProfitCents,
    manualTotalProfitCents,
    buyDate,
    redeemDate,
    stamp,
    stamp,
  )
  return { product: serializeProduct(getRowById(db, id)) }
}

/** 更新产品 patch 的允许字段：对外 patch 键 -> 数据库列。 */
const PATCH_COLUMNS = {
  product_name: 'product_name',
  holdingAmountYuan: 'holding_amount_cents',
  shares: 'shares',
  costNav: 'cost_nav',
  manualDailyProfitYuan: 'manual_daily_profit_cents',
  manualTotalProfitYuan: 'manual_total_profit_cents',
  buyDate: 'buy_date',
  redeemDate: 'redeem_date',
  active: 'active',
}

/**
 * 修改理财产品（只允许可改字段：名称/金额/份额/成本净值/手动收益/日期/active）。
 * patch 中未出现的键保持原值；可选字段显式 null/'' 表示清空。
 */
export function updateProduct(db, { id, patch = {}, today } = {}) {
  const productId = textField(id, 'id')
  const row = getRowById(db, productId)
  if (!row) throw fail(CODES.product_not_found, `理财产品不存在：${productId}`, { id: productId })
  if (today) dateField(today, 'today')
  const updates = []
  const values = []
  const merged = { ...row }
  const entries = Object.entries(patch ?? {}).filter(([key]) => key in PATCH_COLUMNS)
  for (const [key, value] of entries) {
    const column = PATCH_COLUMNS[key]
    if (key === 'product_name') {
      merged.product_name = textField(value, 'product_name')
    } else if (key === 'holdingAmountYuan') {
      merged.holding_amount_cents = centsField(value, 'holding_amount', { positive: true })
    } else if (key === 'shares' || key === 'costNav') {
      merged[column] = optionalPositiveNumber(value, key === 'shares' ? 'shares' : 'cost_nav')
    } else if (key === 'manualDailyProfitYuan' || key === 'manualTotalProfitYuan') {
      merged[column] = optionalCentsField(value, column)
    } else if (key === 'buyDate' || key === 'redeemDate') {
      merged[column] =
        value === undefined || value === null || value === ''
          ? null
          : dateField(value, key === 'buyDate' ? 'buy_date' : 'redeem_date')
    } else if (key === 'active') {
      if (typeof value !== 'boolean') throw fail(CODES.invalid_argument, 'active 必须是布尔值', { field: 'active' })
      merged.active = value ? 1 : 0
    }
    updates.push(`${column} = ?`)
    values.push(merged[column])
  }
  if (updates.length === 0) {
    throw fail(CODES.invalid_argument, '没有可修改的字段', { field: 'patch' })
  }
  if (merged.buy_date && merged.redeem_date && daysBetween(merged.buy_date, merged.redeem_date) < 0) {
    throw fail(CODES.invalid_date, 'redeem_date 不能早于 buy_date', { field: 'redeem_date' })
  }

  updates.push('last_updated = ?')
  values.push(nowIso())
  values.push(productId)
  db.prepare(`UPDATE wealth_products SET ${updates.join(', ')} WHERE id = ?`).run(...values)
  return { product: serializeProduct(getRowById(db, productId)) }
}

/**
 * 列出理财产品。
 * @param {{active?: boolean|null}} [options] active=true 仅持有中；false 仅已归档；null 全部
 */
export function listProducts(db, { active = true } = {}) {
  let rows
  if (active === null || active === undefined) {
    rows = db.prepare('SELECT * FROM wealth_products ORDER BY created_at ASC').all()
  } else {
    rows = db.prepare('SELECT * FROM wealth_products WHERE active = ? ORDER BY created_at ASC').all(active ? 1 : 0)
  }
  return { products: rows.map(serializeProduct) }
}

/** 按 id（优先）或 identifier（可加 product_type）查产品，返回对外 JSON 或 null。 */
export function findProduct(db, { id, identifier, product_type: productType } = {}) {
  let row = null
  if (id !== undefined && id !== null && id !== '') {
    row = getRowById(db, String(id))
  } else if (identifier !== undefined && identifier !== null && identifier !== '') {
    if (productType !== undefined && productType !== null && productType !== '') {
      if (!PRODUCT_TYPES.includes(productType)) {
        throw fail(CODES.invalid_type, `product_type 必须是 ${PRODUCT_TYPES.join(' | ')}`, { field: 'product_type' })
      }
      row = getRowByIdentifier(db, productType, String(identifier))
    } else {
      row =
        db
          .prepare('SELECT * FROM wealth_products WHERE identifier = ? ORDER BY created_at ASC LIMIT 1')
          .get(String(identifier)) ?? null
    }
  } else {
    throw fail(CODES.invalid_argument, 'findProduct 需要 id 或 identifier', { field: 'id' })
  }
  return row ? serializeProduct(row) : null
}

/** 归档产品（active = 0）。 */
export function archiveProduct(db, { id, today } = {}) {
  const productId = textField(id, 'id')
  if (!getRowById(db, productId)) {
    throw fail(CODES.product_not_found, `理财产品不存在：${productId}`, { id: productId })
  }
  if (today) dateField(today, 'today')
  db.prepare('UPDATE wealth_products SET active = 0, last_updated = ? WHERE id = ?').run(nowIso(), productId)
  return { product: serializeProduct(getRowById(db, productId)) }
}

/** 读取一行收益（内部原始行，可能为 null）。 */
function getProfitRow(db, productId, profitDate) {
  return (
    db
      .prepare('SELECT * FROM wealth_daily_profit WHERE product_id = ? AND profit_date = ?')
      .get(productId, profitDate) ?? null
  )
}

/**
 * 记录某产品某天的收益；同日重跑幂等覆盖。
 * @returns {{ profit: object, replaced: boolean }}
 */
export function recordDailyProfit(
  db,
  { productId, profitDate, amountCents, source, navDate = null, detail = null } = {},
) {
  const id = textField(productId, 'product_id')
  if (!getRowById(db, id)) throw fail(CODES.product_not_found, `理财产品不存在：${id}`, { id })
  const day = dateField(profitDate, 'profit_date')
  if (!PROFIT_SOURCES.includes(source)) {
    throw fail(CODES.invalid_source, `source 必须是 ${PROFIT_SOURCES.join(' | ')}`, { field: 'source' })
  }
  if (!Number.isSafeInteger(amountCents)) {
    throw fail(CODES.invalid_amount, 'amountCents 必须是整数分', { field: 'amountCents' })
  }
  const nav = navDate === undefined || navDate === null || navDate === ''
    ? null
    : dateField(navDate, 'nav_date')
  const existing = getProfitRow(db, id, day)
  const profitId = existing?.id ?? newId('profit')
  const fetchedAt = nowIso()
  db.prepare(
    `INSERT INTO wealth_daily_profit (id, product_id, profit_date, amount_cents, source, nav_date, detail, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (product_id, profit_date) DO UPDATE SET
       amount_cents = excluded.amount_cents,
       source = excluded.source,
       nav_date = excluded.nav_date,
       detail = excluded.detail,
       fetched_at = excluded.fetched_at`,
  ).run(profitId, id, day, amountCents, source, nav, detail ?? null, fetchedAt)
  return { profit: getProfitRow(db, id, day), replaced: existing !== null }
}

/** 读取某产品某天的收益，没有返回 null。 */
export function getProfitForDate(db, productId, profitDate) {
  const id = textField(productId, 'product_id')
  const day = dateField(profitDate, 'profit_date')
  return getProfitRow(db, id, day)
}

/** 读取某产品最近一次收益（可限定 onOrBefore）。 */
export function getLatestProfit(db, productId, { onOrBefore = null } = {}) {
  const id = textField(productId, 'product_id')
  if (onOrBefore === null || onOrBefore === undefined) {
    return (
      db
        .prepare('SELECT * FROM wealth_daily_profit WHERE product_id = ? ORDER BY profit_date DESC LIMIT 1')
        .get(id) ?? null
    )
  }
  const bound = dateField(onOrBefore, 'onOrBefore')
  return (
    db
      .prepare(
        'SELECT * FROM wealth_daily_profit WHERE product_id = ? AND profit_date <= ? ORDER BY profit_date DESC LIMIT 1',
      )
      .get(id, bound) ?? null
  )
}

/** 列出收益记录，可按产品与月份过滤（profit_date 升序）。 */
export function listProfits(db, { productId, month } = {}) {
  const where = []
  const params = []
  if (productId !== undefined && productId !== null && productId !== '') {
    where.push('product_id = ?')
    params.push(textField(productId, 'product_id'))
  }
  if (month !== undefined && month !== null && month !== '') {
    try {
      assertMonth(month)
    } catch (error) {
      throw fail(CODES.invalid_month, `month 不合法：${error.message}`, { field: 'month' })
    }
    const { start, end } = monthRange(month)
    where.push('profit_date BETWEEN ? AND ?')
    params.push(start, end)
  }
  const sql = `SELECT * FROM wealth_daily_profit${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY profit_date ASC, product_id ASC`
  return { profits: db.prepare(sql).all(...params) }
}

/**
 * 理财汇总（只给理财模块用，绝不与记账数字合并）。
 * @param {{month?: string, today?: string}} [options]
 */
export function getWealthSummary(db, { month, today } = {}) {
  const day = today === undefined || today === null || today === '' ? dateInZone(new Date()) : dateField(today, 'today')
  const targetMonth = month === undefined || month === null || month === ''
    ? monthKeyOf(day)
    : (() => {
        try {
          return assertMonth(month)
        } catch (error) {
          throw fail(CODES.invalid_month, `month 不合法：${error.message}`, { field: 'month' })
        }
      })()
  const { start, end } = monthRange(targetMonth)
  const yesterday = addDays(day, -1)

  const rows = db.prepare('SELECT * FROM wealth_products WHERE active = 1 ORDER BY created_at ASC').all()
  const monthAggStmt = db.prepare(
    `SELECT COALESCE(SUM(amount_cents), 0) AS cents, COUNT(*) AS days
       FROM wealth_daily_profit WHERE product_id = ? AND profit_date BETWEEN ? AND ?`,
  )
  const totalAggStmt = db.prepare(
    'SELECT COALESCE(SUM(amount_cents), 0) AS cents FROM wealth_daily_profit WHERE product_id = ?',
  )

  const products = []
  let holdingCents = 0
  let monthProfitCents = 0
  let totalProfitCents = 0
  const missing = []

  for (const row of rows) {
    const monthAgg = monthAggStmt.get(row.id, start, end)
    const monthProfit = Number(monthAgg?.cents ?? 0)
    const monthDays = Number(monthAgg?.days ?? 0)
    const manualTotal = row.manual_total_profit_cents
    const totalSource = manualTotal === null || manualTotal === undefined ? 'sum' : 'manual'
    const totalProfit =
      totalSource === 'manual' ? Number(manualTotal) : Number(totalAggStmt.get(row.id)?.cents ?? 0)
    const last = getLatestProfit(db, row.id)
    const lastProfit = last
      ? { profit_date: last.profit_date, amount_cents: last.amount_cents, source: last.source }
      : null
    const stale = last !== null && (last.source === 'stale' || last.profit_date < yesterday)
    const redeemDate = row.redeem_date ?? null
    const daysToRedeem = redeemDate ? daysBetween(day, redeemDate) : null

    products.push({
      id: row.id,
      product_name: row.product_name,
      product_type: row.product_type,
      identifier: row.identifier,
      holding_amount_cents: row.holding_amount_cents,
      month_profit_cents: monthProfit,
      month_data_days: monthDays,
      total_profit_cents: totalProfit,
      total_profit_source: totalSource,
      last_profit: lastProfit,
      stale,
      redeem_date: redeemDate,
      days_to_redeem: daysToRedeem,
    })

    holdingCents += row.holding_amount_cents
    monthProfitCents += monthProfit
    totalProfitCents += totalProfit

    if (monthDays === 0) {
      missing.push({
        id: row.id,
        product_name: row.product_name,
        reason:
          row.product_type === 'bank_wealth'
            ? '银行理财暂无可用免费数据源，本月无收益记录'
            : '本月无收益记录',
      })
    }
  }

  const expiring = products
    .filter((p) => p.redeem_date !== null && p.days_to_redeem !== null && p.days_to_redeem >= 0 && p.days_to_redeem <= 7)
    .map((p) => ({
      id: p.id,
      product_name: p.product_name,
      redeem_date: p.redeem_date,
      days_left: p.days_to_redeem,
    }))
    .sort((a, b) => a.days_left - b.days_left)

  return {
    month: targetMonth,
    products,
    totals: {
      holding_cents: holdingCents,
      month_profit_cents: monthProfitCents,
      total_profit_cents: totalProfitCents,
    },
    missing_product_count: missing.length,
    missing_products: missing,
    expiring,
  }
}
