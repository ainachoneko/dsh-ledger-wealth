/**
 * A 模块领域逻辑：日常记账（支出 / 收入）。
 *
 * 设计要点：
 * - 所有金额落库一律是**整数分**（列名 `amount_cents`），对外 JSON 才转成元；
 *   元 <-> 分 的转换只走 `lib/money.js`，本文件不自己写换算。
 * - 初始余额是记账账本的起点：未设置时任何写账操作都抛 `need_initial_balance`，
 *   **绝不默认按 0 处理**（这是需求里的硬约束）。
 * - 结余 `balance_cents = 初始余额 + Σ收入 − Σ支出`（全历史）。
 * - 记账表与理财表物理隔离：本文件只读写 `ledger_entries` 与两个初始余额 meta 键，
 *   不会触碰 `wealth_*` 表，也不会把理财收益算进记账结余。
 * @module dsh-ledger-wealth/ledger
 */

import { getMeta, getMetaInt, newId, setMeta, transaction } from './db.js'
import { assertDate, assertMonth, dateInZone, monthKeyOf, monthRange } from './dates.js'
import { CODES, fail } from './errors.js'
import { CATEGORIES, formatCny, fromCents, percentOf, toCents, toPositiveCents } from './money.js'

/** 记账类型（与数据库 CHECK 约束一致）。 */
const TYPES = ['expense', 'income']

/** 记账来源（与数据库 CHECK 约束一致）。 */
const SOURCES = ['text', 'ocr']

/** meta 键：初始余额（分）。 */
const INITIAL_BALANCE_KEY = 'initial_balance_cents'
/** meta 键：初始余额设置时间。 */
const INITIAL_BALANCE_AT_KEY = 'initial_balance_set_at'

/**
 * 读取初始余额。
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {{ cents: number, set_at: string | null } | null} 未设置时返回 null
 */
export function getInitialBalance(db) {
  const raw = getMeta(db, INITIAL_BALANCE_KEY)
  if (raw === undefined) return null
  const cents = getMetaInt(db, INITIAL_BALANCE_KEY)
  if (cents === null) return null
  return { cents, set_at: getMeta(db, INITIAL_BALANCE_AT_KEY) ?? null }
}

/**
 * 要求初始余额已设置，否则抛 `need_initial_balance`。
 * 记账的每个写入路径都必须先过这里。
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {{ cents: number, set_at: string | null }}
 */
export function requireInitialBalance(db) {
  const balance = getInitialBalance(db)
  if (balance === null) {
    throw fail(
      CODES.need_initial_balance,
      '尚未设置初始余额，请先调用 ledger_set_initial_balance 设置（记账不会默认按 0 处理）。',
      { hint: '设置初始余额后即可记账' },
    )
  }
  return balance
}

/**
 * 设置初始余额。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ amountYuan: number|string, today?: string, nowIso?: string, overwrite?: boolean }} input
 * @returns {{ initial_balance_cents: number, initial_balance: number, set_at: string }}
 */
export function setInitialBalance(db, { amountYuan, today, nowIso, overwrite = false } = {}) {
  let cents
  try {
    cents = toCents(amountYuan, 'amount')
  } catch (error) {
    throw fail(CODES.invalid_amount, `初始余额必须是元金额（最多两位小数）：${String(amountYuan)}`, {
      field: 'amount',
      detail: error.message,
    })
  }
  if (cents < 0) {
    throw fail(CODES.invalid_amount, '初始余额不能为负数。', { field: 'amount' })
  }
  if (today !== undefined && today !== null && today !== '') {
    try {
      assertDate(today, 'today')
    } catch (error) {
      throw fail(CODES.invalid_date, `日期必须是真实存在的 YYYY-MM-DD：${String(today)}`, {
        field: 'today',
        detail: error.message,
      })
    }
  }

  const existing = getInitialBalance(db)
  if (existing !== null && overwrite !== true) {
    throw fail(
      CODES.already_initialized,
      `初始余额已设置为 ${formatCny(existing.cents)}，如需修改请显式传 overwrite: true。`,
      { initial_balance_cents: existing.cents, set_at: existing.set_at },
    )
  }

  const setAt = nowIso ?? (today ? `${today}T00:00:00.000Z` : new Date().toISOString())
  transaction(db, () => {
    setMeta(db, INITIAL_BALANCE_KEY, String(cents), setAt)
    setMeta(db, INITIAL_BALANCE_AT_KEY, setAt, setAt)
  })

  return { initial_balance_cents: cents, initial_balance: fromCents(cents), set_at: setAt }
}

/**
 * 记一笔账。校验失败抛对应错误码；成功后返回入库行、最新余额与当月汇总。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ type: string, amountYuan: number|string, category: string, merchant?: string|null,
 *           note?: string|null, date?: string, source?: string }} input
 * @returns {{ entry: Record<string, unknown>, balances: ReturnType<typeof getBalances>,
 *             month_summary: ReturnType<typeof getMonthSummary> }}
 */
export function recordEntry(db, { type, amountYuan, category, merchant = null, note = null, date, source = 'text' } = {}) {
  // 硬约束：未设置初始余额时任何写账操作都要报 need_initial_balance，不得静默按 0 记。
  requireInitialBalance(db)

  const entryType = normalizeType(type)
  const amountCents = normalizeAmount(amountYuan)
  const categoryValue = normalizeCategory(category)
  const entryDate = date === undefined || date === null || date === '' ? dateInZone() : normalizeDate(date)
  const entrySource = normalizeSource(source)
  const merchantValue = normalizeOptionalText(merchant, 'merchant')
  const noteValue = normalizeOptionalText(note, 'note')

  const id = newId('entry')
  const createdAt = new Date().toISOString()
  transaction(db, () => {
    db.prepare(
      `INSERT INTO ledger_entries (id, entry_date, type, amount_cents, category, merchant, note, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, entryDate, entryType, amountCents, categoryValue, merchantValue, noteValue, entrySource, createdAt)
  })

  const entry = db.prepare('SELECT * FROM ledger_entries WHERE id = ?').get(id)
  return {
    entry,
    balances: getBalances(db),
    month_summary: getMonthSummary(db, monthKeyOf(entryDate)),
  }
}

/**
 * 列出账目（按日期倒序）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ month?: string, type?: string, limit?: number, offset?: number }} [options]
 * @returns {{ entries: Record<string, unknown>[], total: number }}
 */
export function listEntries(db, { month, type, limit = 50, offset = 0 } = {}) {
  const clauses = []
  const params = []

  if (month !== undefined && month !== null && month !== '') {
    const monthValue = normalizeMonth(month)
    const range = monthRange(monthValue)
    clauses.push('entry_date >= ? AND entry_date <= ?')
    params.push(range.start, range.end)
  }
  if (type !== undefined && type !== null && type !== '') {
    clauses.push('type = ?')
    params.push(normalizeType(type))
  }

  const limitValue = normalizeInteger(limit, 'limit', { fallback: 50, min: 1, max: 500 })
  const offsetValue = normalizeInteger(offset, 'offset', { fallback: 0, min: 0, max: 1_000_000 })

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
  const entries = db
    .prepare(
      `SELECT * FROM ledger_entries ${where}
       ORDER BY entry_date DESC, created_at DESC, id ASC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, limitValue, offsetValue)

  const total = db.prepare(`SELECT COUNT(*) AS c FROM ledger_entries ${where}`).get(...params).c

  return { entries, total: Number(total) }
}

/**
 * 删除一笔账目。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ id: string }} input
 * @returns {{ deleted: Record<string, unknown> }}
 */
export function deleteEntry(db, { id } = {}) {
  if (typeof id !== 'string' || id.trim() === '') {
    throw fail(CODES.invalid_argument, 'id 必须是非空的账目 id。', { field: 'id' })
  }
  const entryId = id.trim()
  const entry = db.prepare('SELECT * FROM ledger_entries WHERE id = ?').get(entryId)
  if (entry === undefined) {
    throw fail(CODES.entry_not_found, `未找到该记账记录：${entryId}`, { id: entryId })
  }
  db.prepare('DELETE FROM ledger_entries WHERE id = ?').run(entryId)
  return { deleted: entry }
}

/**
 * 全历史余额。未设置初始余额时抛 `need_initial_balance`。
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {{ initial_balance_cents: number, income_cents: number, expense_cents: number, balance_cents: number }}
 */
export function getBalances(db) {
  const initial = requireInitialBalance(db)
  const sums = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN type = 'income' THEN amount_cents ELSE 0 END), 0) AS income_cents,
         COALESCE(SUM(CASE WHEN type = 'expense' THEN amount_cents ELSE 0 END), 0) AS expense_cents
       FROM ledger_entries`,
    )
    .get()
  const incomeCents = Number(sums.income_cents)
  const expenseCents = Number(sums.expense_cents)
  return {
    initial_balance_cents: initial.cents,
    income_cents: incomeCents,
    expense_cents: expenseCents,
    balance_cents: initial.cents + incomeCents - expenseCents,
  }
}

/**
 * 月度汇总（报告用）。金额字段一律整数分。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} month 'YYYY-MM'
 * @param {{ topCategories?: number }} [options]
 * @returns {{
 *   month: string,
 *   entry_count: number, expense_entry_count: number, income_entry_count: number,
 *   expense_cents: number, income_cents: number, net_cents: number,
 *   categories: { category: string, expense_cents: number, share: string | null }[],
 *   largest_expense: { id: string, date: string, merchant: string|null, category: string,
 *                        note: string|null, amount_cents: number } | null,
 *   daily: { date: string, expense_cents: number, income_cents: number }[],
 * }}
 */
export function getMonthSummary(db, month, { topCategories = 5 } = {}) {
  const monthValue = normalizeMonth(month)
  const categoryLimit = normalizeInteger(topCategories, 'topCategories', { fallback: 5, min: 1, max: 20 })
  const { start, end } = monthRange(monthValue)

  const totals = db
    .prepare(
      `SELECT
         COUNT(*) AS entry_count,
         COALESCE(SUM(CASE WHEN type = 'expense' THEN 1 ELSE 0 END), 0) AS expense_entry_count,
         COALESCE(SUM(CASE WHEN type = 'income' THEN 1 ELSE 0 END), 0) AS income_entry_count,
         COALESCE(SUM(CASE WHEN type = 'expense' THEN amount_cents ELSE 0 END), 0) AS expense_cents,
         COALESCE(SUM(CASE WHEN type = 'income' THEN amount_cents ELSE 0 END), 0) AS income_cents
       FROM ledger_entries
       WHERE entry_date >= ? AND entry_date <= ?`,
    )
    .get(start, end)

  const expenseCents = Number(totals.expense_cents)
  const incomeCents = Number(totals.income_cents)

  const categoryRows = db
    .prepare(
      `SELECT category, COALESCE(SUM(amount_cents), 0) AS expense_cents
       FROM ledger_entries
       WHERE type = 'expense' AND entry_date >= ? AND entry_date <= ?
       GROUP BY category
       ORDER BY expense_cents DESC, category ASC
       LIMIT ?`,
    )
    .all(start, end, categoryLimit)

  const categories = categoryRows.map((row) => {
    const cents = Number(row.expense_cents)
    return {
      category: row.category,
      expense_cents: cents,
      share: percentOf(cents, expenseCents),
    }
  })

  const largestRow = db
    .prepare(
      `SELECT * FROM ledger_entries
       WHERE type = 'expense' AND entry_date >= ? AND entry_date <= ?
       ORDER BY amount_cents DESC, entry_date DESC, id ASC
       LIMIT 1`,
    )
    .get(start, end)

  const largest_expense = largestRow
    ? {
        id: largestRow.id,
        date: largestRow.entry_date,
        merchant: largestRow.merchant ?? null,
        category: largestRow.category,
        note: largestRow.note ?? null,
        amount_cents: Number(largestRow.amount_cents),
      }
    : null

  const daily = db
    .prepare(
      `SELECT entry_date AS date,
         COALESCE(SUM(CASE WHEN type = 'expense' THEN amount_cents ELSE 0 END), 0) AS expense_cents,
         COALESCE(SUM(CASE WHEN type = 'income' THEN amount_cents ELSE 0 END), 0) AS income_cents
       FROM ledger_entries
       WHERE entry_date >= ? AND entry_date <= ?
       GROUP BY entry_date
       ORDER BY entry_date ASC`,
    )
    .all(start, end)
    .map((row) => ({
      date: row.date,
      expense_cents: Number(row.expense_cents),
      income_cents: Number(row.income_cents),
    }))

  return {
    month: monthValue,
    entry_count: Number(totals.entry_count),
    expense_entry_count: Number(totals.expense_entry_count),
    income_entry_count: Number(totals.income_entry_count),
    expense_cents: expenseCents,
    income_cents: incomeCents,
    net_cents: incomeCents - expenseCents,
    categories,
    largest_expense,
    daily,
  }
}

/**
 * 数据库行 -> 对外 JSON（金额为元 number，两个小数位）。
 * @param {Record<string, unknown>} row `ledger_entries` 行
 * @returns {{ id: string, type: string, amount: number, category: string,
 *             merchant: string|null, date: string, note: string|null,
 *             source: string, created_at: string }}
 */
export function serializeEntry(row) {
  return {
    id: row.id,
    type: row.type,
    amount: fromCents(Number(row.amount_cents)),
    category: row.category,
    merchant: row.merchant ?? null,
    date: row.entry_date,
    note: row.note ?? null,
    source: row.source,
    created_at: row.created_at,
  }
}

// ── 内部校验 ───────────────────────────────────────────────────────────────

function normalizeType(value) {
  if (value !== 'expense' && value !== 'income') {
    throw fail(CODES.invalid_type, '类型必须是 expense（支出）或 income（收入）。', {
      field: 'type',
      allowed: TYPES,
      value: value ?? null,
    })
  }
  return value
}

function normalizeAmount(value) {
  try {
    return toPositiveCents(value, 'amount')
  } catch (error) {
    throw fail(CODES.invalid_amount, `金额必须是大于 0 的元金额（最多两位小数）：${String(value)}`, {
      field: 'amount',
      detail: error.message,
    })
  }
}

function normalizeCategory(value) {
  if (typeof value !== 'string' || !CATEGORIES.includes(value)) {
    throw fail(CODES.invalid_category, `分类必须是以下之一：${CATEGORIES.join('、')}`, {
      field: 'category',
      allowed: CATEGORIES,
      value: value ?? null,
    })
  }
  return value
}

function normalizeDate(value) {
  try {
    return assertDate(value, 'date')
  } catch (error) {
    throw fail(CODES.invalid_date, `日期必须是真实存在的 YYYY-MM-DD：${String(value)}`, {
      field: 'date',
      detail: error.message,
    })
  }
}

function normalizeSource(value) {
  if (!SOURCES.includes(value)) {
    throw fail(CODES.invalid_source, '来源必须是 text（文字录入）或 ocr（小票识别）。', {
      field: 'source',
      allowed: SOURCES,
      value: value ?? null,
    })
  }
  return value
}

function normalizeOptionalText(value, field) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') {
    throw fail(CODES.invalid_argument, `${field} 必须是字符串。`, { field })
  }
  const text = value.trim()
  return text === '' ? null : text
}

function normalizeMonth(value) {
  try {
    return assertMonth(value)
  } catch (error) {
    throw fail(CODES.invalid_month, `月份必须是 YYYY-MM：${String(value)}`, {
      field: 'month',
      detail: error.message,
    })
  }
}

function normalizeInteger(value, field, { fallback, min, max }) {
  if (value === undefined || value === null || value === '') return fallback
  const n = typeof value === 'number' ? value : Number(String(value).trim())
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
    throw fail(CODES.invalid_argument, `${field} 必须是 ${min}..${max} 之间的整数。`, { field, value })
  }
  return n
}
