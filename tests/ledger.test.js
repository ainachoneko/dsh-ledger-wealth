/**
 * A 模块（日常记账）单元测试。
 *
 * 全部使用内存库 `openDb(':memory:')`，不联网、不写用户真实数据库；
 * "今天"一律由用例显式传入，不依赖系统时钟。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { openDb } from '../lib/db.js'
import {
  deleteEntry,
  getBalances,
  getInitialBalance,
  getMonthSummary,
  listEntries,
  recordEntry,
  requireInitialBalance,
  serializeEntry,
  setInitialBalance,
} from '../lib/ledger.js'
import { registerLedgerTools } from '../lib/tools/ledger.js'

/** 建一个测试用内存库，并在用例结束时关闭。 */
function freshDb(t) {
  const db = openDb(':memory:')
  t.after(() => db.close())
  return db
}

/** 断言 fn 抛出 LedgerError 并返回它。 */
function catchError(fn) {
  try {
    fn()
  } catch (error) {
    return error
  }
  throw new Error('预期抛错，但函数正常返回了')
}

/** 注册工具到一个假 ctx，返回 name -> definition 的 Map。 */
function setupTools(db) {
  const registry = new Map()
  const ctx = { tools: { register: (definition) => registry.set(definition.name, definition) } }
  registerLedgerTools(ctx, { db, config: { timeZone: 'Asia/Shanghai' } })
  return registry
}

/** 直接查询行数，用于断言"预览不落库"。 */
function entryCount(db) {
  return db.prepare('SELECT COUNT(*) AS c FROM ledger_entries').get().c
}

test('初始余额未设置时，记账与余额查询都报 need_initial_balance', (t) => {
  const db = freshDb(t)

  assert.equal(getInitialBalance(db), null)
  assert.equal(catchError(() => requireInitialBalance(db)).code, 'need_initial_balance')

  const recordError = catchError(() =>
    recordEntry(db, { type: 'expense', amountYuan: 10, category: '餐饮', date: '2026-10-01' }),
  )
  assert.equal(recordError.code, 'need_initial_balance')
  assert.match(recordError.message, /初始余额/)
  assert.equal(entryCount(db), 0, '未设置初始余额时不应落库')

  assert.equal(catchError(() => getBalances(db)).code, 'need_initial_balance')
  // 汇总只读，不要求初始余额。
  assert.equal(getMonthSummary(db, '2026-10').entry_count, 0)
})

test('设置初始余额：首次成功、重复设置报 already_initialized、overwrite 可覆盖', (t) => {
  const db = freshDb(t)

  const created = setInitialBalance(db, {
    amountYuan: 1000.55,
    today: '2026-10-01',
    nowIso: '2026-10-01T00:00:00.000Z',
  })
  assert.equal(created.initial_balance_cents, 100055)
  assert.equal(created.initial_balance, 1000.55)
  assert.equal(created.set_at, '2026-10-01T00:00:00.000Z')

  const stored = getInitialBalance(db)
  assert.equal(stored.cents, 100055)
  assert.equal(stored.set_at, '2026-10-01T00:00:00.000Z')

  const duplicate = catchError(() => setInitialBalance(db, { amountYuan: 2000 }))
  assert.equal(duplicate.code, 'already_initialized')
  assert.equal(duplicate.details.initial_balance_cents, 100055)

  const overwritten = setInitialBalance(db, {
    amountYuan: 2000,
    overwrite: true,
    nowIso: '2026-10-02T00:00:00.000Z',
  })
  assert.equal(overwritten.initial_balance_cents, 200000)
  assert.equal(getBalances(db).balance_cents, 200000)
})

test('记账按整数分落库，余额 = 初始余额 + 收入 − 支出', (t) => {
  const db = freshDb(t)
  setInitialBalance(db, { amountYuan: 1000, today: '2026-10-01' })

  const expense = recordEntry(db, {
    type: 'expense',
    amountYuan: 25.5,
    category: '餐饮',
    merchant: '  老王面馆  ',
    note: '午饭',
    date: '2026-10-03',
    source: 'text',
  })
  assert.equal(expense.entry.amount_cents, 2550)
  assert.ok(Number.isInteger(expense.entry.amount_cents))
  assert.equal(expense.entry.merchant, '老王面馆')
  assert.equal(expense.balances.balance_cents, 100000 - 2550)

  const income = recordEntry(db, {
    type: 'income',
    amountYuan: 3000,
    category: '工资',
    date: '2026-10-05',
  })
  assert.equal(income.entry.amount_cents, 300000)

  const balances = getBalances(db)
  assert.deepEqual(balances, {
    initial_balance_cents: 100000,
    income_cents: 300000,
    expense_cents: 2550,
    balance_cents: 100000 + 300000 - 2550,
  })
  assert.equal(entryCount(db), 2)
})

test('recordEntry 参数校验返回稳定错误码', (t) => {
  const db = freshDb(t)
  setInitialBalance(db, { amountYuan: 100, today: '2026-10-01' })
  const base = { type: 'expense', amountYuan: 10, category: '餐饮', date: '2026-10-03' }

  assert.equal(catchError(() => recordEntry(db, { ...base, amountYuan: 0 })).code, 'invalid_amount')
  assert.equal(catchError(() => recordEntry(db, { ...base, amountYuan: -5 })).code, 'invalid_amount')
  // 字符串超过两位小数、非数字、非有限数都必须被拒绝（口径由 lib/money.js 决定）。
  assert.equal(catchError(() => recordEntry(db, { ...base, amountYuan: '1.234' })).code, 'invalid_amount')
  assert.equal(catchError(() => recordEntry(db, { ...base, amountYuan: 'abc' })).code, 'invalid_amount')
  assert.equal(catchError(() => recordEntry(db, { ...base, amountYuan: Number.NaN })).code, 'invalid_amount')
  assert.equal(catchError(() => recordEntry(db, { ...base, type: 'transfer' })).code, 'invalid_type')
  assert.equal(catchError(() => recordEntry(db, { ...base, category: '不存在' })).code, 'invalid_category')
  assert.equal(catchError(() => recordEntry(db, { ...base, date: '2026-02-30' })).code, 'invalid_date')
  assert.equal(catchError(() => recordEntry(db, { ...base, date: '2026/10/03' })).code, 'invalid_date')
  assert.equal(catchError(() => recordEntry(db, { ...base, source: 'api' })).code, 'invalid_source')

  // 全部失败都不应落库。
  assert.equal(entryCount(db), 0)
})

test('getMonthSummary 统计笔数、分类占比、最大单笔与每日明细', (t) => {
  const db = freshDb(t)
  setInitialBalance(db, { amountYuan: 500, today: '2026-09-01' })

  const rows = [
    { type: 'expense', amountYuan: 28, category: '餐饮', date: '2026-10-03', merchant: 'A' },
    { type: 'expense', amountYuan: 10, category: '交通', date: '2026-10-03' },
    { type: 'expense', amountYuan: 50, category: '餐饮', date: '2026-10-05', merchant: 'B' },
    { type: 'income', amountYuan: 3000, category: '工资', date: '2026-10-05' },
    { type: 'expense', amountYuan: 20, category: '购物', date: '2026-10-06' },
    { type: 'expense', amountYuan: 99, category: '餐饮', date: '2026-09-30' }, // 上月，不应计入
  ]
  for (const row of rows) recordEntry(db, row)

  const summary = getMonthSummary(db, '2026-10')
  assert.equal(summary.month, '2026-10')
  assert.equal(summary.entry_count, 5)
  assert.equal(summary.expense_entry_count, 4)
  assert.equal(summary.income_entry_count, 1)
  assert.equal(summary.expense_cents, 2800 + 1000 + 5000 + 2000)
  assert.equal(summary.income_cents, 300000)
  assert.equal(summary.net_cents, 300000 - 10800)

  // 分类：仅支出、倒序、含 share 字符串
  assert.deepEqual(
    summary.categories.map((row) => row.category),
    ['餐饮', '购物', '交通'],
  )
  assert.equal(summary.categories[0].expense_cents, 7800)
  assert.equal(summary.categories[0].share, '72.2%')
  assert.equal(summary.categories[1].share, '18.5%')
  assert.equal(summary.categories[2].share, '9.3%')
  assert.match(summary.categories[0].share, /^\d+\.\d%$/)

  // 最大单笔支出
  assert.deepEqual(summary.largest_expense, {
    id: summary.largest_expense.id,
    date: '2026-10-05',
    merchant: 'B',
    category: '餐饮',
    note: null,
    amount_cents: 5000,
  })

  // 每日明细按日期升序，仅本月
  assert.deepEqual(summary.daily, [
    { date: '2026-10-03', expense_cents: 3800, income_cents: 0 },
    { date: '2026-10-05', expense_cents: 5000, income_cents: 300000 },
    { date: '2026-10-06', expense_cents: 2000, income_cents: 0 },
  ])

  // 前 N 类可配置
  assert.equal(getMonthSummary(db, '2026-10', { topCategories: 2 }).categories.length, 2)
  assert.equal(getMonthSummary(db, '2026-10', { topCategories: 5 }).categories.length, 3)

  // 空月份
  const empty = getMonthSummary(db, '2026-08')
  assert.equal(empty.entry_count, 0)
  assert.equal(empty.expense_cents, 0)
  assert.equal(empty.income_cents, 0)
  assert.equal(empty.net_cents, 0)
  assert.deepEqual(empty.categories, [])
  assert.equal(empty.largest_expense, null)
  assert.deepEqual(empty.daily, [])

  // 非法月份
  assert.equal(catchError(() => getMonthSummary(db, '2026-13')).code, 'invalid_month')
  assert.equal(catchError(() => getMonthSummary(db, '202610')).code, 'invalid_month')
})

test('listEntries 支持月份/类型过滤、倒序与分页', (t) => {
  const db = freshDb(t)
  setInitialBalance(db, { amountYuan: 0, today: '2026-10-01' })
  recordEntry(db, { type: 'expense', amountYuan: 10, category: '餐饮', date: '2026-10-01' })
  recordEntry(db, { type: 'expense', amountYuan: 20, category: '购物', date: '2026-10-03' })
  recordEntry(db, { type: 'income', amountYuan: 30, category: '工资', date: '2026-10-02' })
  recordEntry(db, { type: 'expense', amountYuan: 40, category: '餐饮', date: '2026-09-30' })

  const all = listEntries(db, {})
  assert.equal(all.total, 4)
  assert.deepEqual(
    all.entries.map((row) => row.entry_date),
    ['2026-10-03', '2026-10-02', '2026-10-01', '2026-09-30'],
  )

  const october = listEntries(db, { month: '2026-10' })
  assert.equal(october.total, 3)
  assert.ok(october.entries.every((row) => row.entry_date.startsWith('2026-10')))

  const expenses = listEntries(db, { type: 'expense' })
  assert.equal(expenses.total, 3)
  assert.ok(expenses.entries.every((row) => row.type === 'expense'))

  const filtered = listEntries(db, { month: '2026-10', type: 'expense' })
  assert.equal(filtered.total, 2)

  const page = listEntries(db, { limit: 1, offset: 1 })
  assert.equal(page.total, 4)
  assert.equal(page.entries.length, 1)
  assert.equal(page.entries[0].entry_date, '2026-10-02')

  assert.equal(catchError(() => listEntries(db, { month: '2026-13' })).code, 'invalid_month')
  assert.equal(catchError(() => listEntries(db, { type: 'transfer' })).code, 'invalid_type')
  assert.equal(catchError(() => listEntries(db, { limit: 0 })).code, 'invalid_argument')
})

test('deleteEntry 删除记录并回滚余额，重复删除报 entry_not_found', (t) => {
  const db = freshDb(t)
  setInitialBalance(db, { amountYuan: 100, today: '2026-10-01' })
  const { entry } = recordEntry(db, {
    type: 'expense',
    amountYuan: 12.34,
    category: '餐饮',
    date: '2026-10-03',
  })
  assert.equal(getBalances(db).balance_cents, 10000 - 1234)

  const { deleted } = deleteEntry(db, { id: entry.id })
  assert.equal(deleted.id, entry.id)
  assert.equal(deleted.amount_cents, 1234)
  assert.equal(entryCount(db), 0)
  assert.equal(getBalances(db).balance_cents, 10000)

  assert.equal(catchError(() => deleteEntry(db, { id: entry.id })).code, 'entry_not_found')
  assert.equal(catchError(() => deleteEntry(db, { id: '   ' })).code, 'invalid_argument')
})

test('serializeEntry 输出对外 JSON：金额为元 number、缺失字段为 null', (t) => {
  const db = freshDb(t)
  setInitialBalance(db, { amountYuan: 100, today: '2026-10-01' })
  const { entry } = recordEntry(db, {
    type: 'expense',
    amountYuan: 25.5,
    category: '餐饮',
    date: '2026-10-03',
    source: 'ocr',
  })

  const json = serializeEntry(entry)
  assert.deepEqual(json, {
    id: entry.id,
    type: 'expense',
    amount: 25.5,
    category: '餐饮',
    merchant: null,
    date: '2026-10-03',
    note: null,
    source: 'ocr',
    created_at: entry.created_at,
  })
  assert.equal(typeof json.amount, 'number')
  assert.equal(json.amount_cents, undefined, 'serializeEntry 只输出契约字段')
})

test('ledger_add_entry：未确认只预览不落库，confirm=true 才写入', async (t) => {
  const db = freshDb(t)
  const tools = setupTools(db)
  assert.deepEqual([...tools.keys()], [
    'ledger_set_initial_balance',
    'ledger_add_entry',
    'ledger_list_entries',
    'ledger_delete_entry',
    'ledger_balance',
    'ledger_month_summary',
  ])

  // 未设置初始余额时，工具返回 ok:false + need_initial_balance
  const noBalance = await tools.get('ledger_add_entry').execute(
    { type: 'expense', amount: 25, category: '餐饮', date: '2026-10-03' },
    {},
  )
  assert.equal(noBalance.ok, false)
  assert.equal(noBalance.code, 'need_initial_balance')

  const setResult = await tools
    .get('ledger_set_initial_balance')
    .execute({ amount: 1000 }, {})
  assert.equal(setResult.ok, true)
  assert.equal(setResult.initial_balance_cents, 100000)
  assert.equal(setResult.initial_balance, 1000)
  assert.match(setResult.text, /¥1,000\.00/)

  // 未确认：预览 + 中文文案，不落库
  const preview = await tools.get('ledger_add_entry').execute(
    { type: 'expense', amount: 25.5, category: '餐饮', merchant: '老王面馆', date: '2026-10-03' },
    {},
  )
  assert.equal(preview.ok, true)
  assert.equal(preview.status, 'needs_confirmation')
  assert.equal(preview.draft.amount, 25.5)
  assert.equal(preview.draft.amount_cents, 2550)
  assert.equal(preview.draft.date, '2026-10-03')
  assert.match(preview.message, /待确认/)
  assert.match(preview.message, /¥25\.50/)
  assert.match(preview.text, /未入库|未写入/)
  assert.equal(entryCount(db), 0, '预览不应写入数据库')

  // confirm:true 才落库
  const recorded = await tools.get('ledger_add_entry').execute(
    {
      type: 'expense',
      amount: 25.5,
      category: '餐饮',
      merchant: '老王面馆',
      date: '2026-10-03',
      confirm: true,
    },
    {},
  )
  assert.equal(recorded.ok, true)
  assert.equal(recorded.status, 'recorded')
  assert.equal(recorded.entry.amount, 25.5)
  assert.equal(recorded.entry.amount_cents, 2550)
  assert.equal(recorded.balances.balance_cents, 100000 - 2550)
  assert.equal(recorded.balances.balance, 974.5)
  assert.equal(recorded.month.month, '2026-10')
  assert.equal(recorded.month.expense_cents, 2550)
  assert.match(recorded.text, /已记入账本/)
  assert.equal(entryCount(db), 1)

  // 校验失败也走统一错误信封
  const badCategory = await tools
    .get('ledger_add_entry')
    .execute({ type: 'expense', amount: 1, category: '不存在', date: '2026-10-03' }, {})
  assert.equal(badCategory.ok, false)
  assert.equal(badCategory.code, 'invalid_category')
  assert.equal(entryCount(db), 1)
})

test('ledger_delete_entry：未确认只预览，confirm=true 才删除', async (t) => {
  const db = freshDb(t)
  const tools = setupTools(db)
  setInitialBalance(db, { amountYuan: 100, today: '2026-10-01' })

  const recorded = await tools
    .get('ledger_add_entry')
    .execute(
      { type: 'expense', amount: 12.34, category: '餐饮', date: '2026-10-03', confirm: true },
      {},
    )
  const id = recorded.entry.id

  const preview = await tools.get('ledger_delete_entry').execute({ id }, {})
  assert.equal(preview.ok, true)
  assert.equal(preview.status, 'needs_confirmation')
  assert.equal(preview.draft.id, id)
  assert.match(preview.message, /待确认/)
  assert.match(preview.message, /¥12\.34/)
  assert.equal(entryCount(db), 1, '预览不应删除')

  const deleted = await tools.get('ledger_delete_entry').execute({ id, confirm: true }, {})
  assert.equal(deleted.ok, true)
  assert.equal(deleted.status, 'deleted')
  assert.equal(deleted.deleted.id, id)
  assert.match(deleted.text, /已删除/)
  assert.equal(entryCount(db), 0)

  const missing = await tools.get('ledger_delete_entry').execute({ id, confirm: true }, {})
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'entry_not_found')
})

test('ledger_balance / ledger_month_summary / ledger_list_entries 输出契约字段', async (t) => {
  const db = freshDb(t)
  const tools = setupTools(db)

  const noBalance = await tools.get('ledger_balance').execute({}, {})
  assert.equal(noBalance.ok, false)
  assert.equal(noBalance.code, 'need_initial_balance')

  await tools.get('ledger_set_initial_balance').execute({ amount: 500 }, {})
  await tools
    .get('ledger_add_entry')
    .execute({ type: 'expense', amount: 20, category: '餐饮', date: '2026-10-03', confirm: true }, {})
  await tools
    .get('ledger_add_entry')
    .execute({ type: 'income', amount: 300, category: '工资', date: '2026-10-05', confirm: true }, {})

  const balance = await tools.get('ledger_balance').execute({}, {})
  assert.equal(balance.ok, true)
  assert.equal(balance.balances.initial_balance_cents, 50000)
  assert.equal(balance.balances.income_cents, 30000)
  assert.equal(balance.balances.expense_cents, 2000)
  assert.equal(balance.balances.balance_cents, 78000)
  assert.equal(balance.balances.balance, 780)
  assert.match(balance.text, /当前结余/)

  const summaryResult = await tools.get('ledger_month_summary').execute({ month: '2026-10' }, {})
  assert.equal(summaryResult.ok, true)
  const summary = summaryResult.summary
  assert.equal(summary.month, '2026-10')
  assert.equal(summary.entry_count, 2)
  assert.equal(summary.expense_entry_count, 1)
  assert.equal(summary.income_entry_count, 1)
  assert.equal(summary.expense_cents, 2000)
  assert.equal(summary.income_cents, 30000)
  assert.equal(summary.net_cents, 28000)
  assert.equal(summary.categories[0].category, '餐饮')
  assert.equal(summary.categories[0].share, '100.0%')
  assert.equal(summary.categories[0].amount, 20)
  assert.equal(summary.largest_expense.amount_cents, 2000)
  assert.equal(summary.largest_expense.amount, 20)
  assert.ok(Array.isArray(summary.daily))
  assert.match(summaryResult.text, /2026-10 月度记账/)

  const list = await tools.get('ledger_list_entries').execute({ month: '2026-10' }, {})
  assert.equal(list.ok, true)
  assert.equal(list.total, 2)
  assert.equal(list.entries.length, 2)
  assert.equal(list.entries[0].amount_cents, 30000)
  assert.equal(list.entries[0].amount, 300)
  assert.match(list.text, /共 2 笔/)

  const invalidMonth = await tools.get('ledger_month_summary').execute({ month: '2026-13' }, {})
  assert.equal(invalidMonth.ok, false)
  assert.equal(invalidMonth.code, 'invalid_month')
})
