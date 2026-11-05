/**
 * A 模块工具层：把 `lib/ledger.js` 的领域能力注册成 6 个模型可调用的 JSON 工具。
 *
 * 约定：
 * - 一律用 `lib/toolkit.js` 的 `registerJsonTool` 注册；领域层抛 `LedgerError`，
 *   toolkit 统一转成 `{ ok:false, code, message }`，本文件不自己拼错误对象。
 * - 写操作（记账 / 删除）必须经过用户确认：`confirm !== true` 时只返回
 *   `{ ok:true, status:'needs_confirmation', draft, message }`，**不落库**。
 * - 对外金额一律「元（number，两位）+ `*_cents` 整数分」，方便展示与精确计算。
 * @module dsh-ledger-wealth/tools/ledger
 */

import { dateInZone, assertDate } from '../dates.js'
import { CODES, fail } from '../errors.js'
import {
  deleteEntry,
  getBalances,
  getMonthSummary,
  listEntries,
  recordEntry,
  requireInitialBalance,
  serializeEntry,
  setInitialBalance,
} from '../ledger.js'
import { CATEGORIES, formatCny, fromCents, toPositiveCents } from '../money.js'
import { okBody, registerJsonTool } from '../toolkit.js'

const TYPE_LABELS = { expense: '支出', income: '收入' }
const SOURCE_LABELS = { text: '文字录入', ocr: '小票识别' }
const SOURCES = ['text', 'ocr']

/** 当前日期（按配置时区）。 */
function todayOf(config) {
  return dateInZone(new Date(), config?.timeZone ?? 'Asia/Shanghai')
}

function typeLabel(type) {
  return TYPE_LABELS[type] ?? type
}

/** 账目行 -> 对外 JSON（元 + 精确分）。 */
function entryDto(row) {
  return { ...serializeEntry(row), amount_cents: Number(row.amount_cents) }
}

/** 余额 -> 对外 JSON（元 + 精确分）。 */
function balancesDto(balances) {
  return {
    initial_balance_cents: balances.initial_balance_cents,
    initial_balance: fromCents(balances.initial_balance_cents),
    income_cents: balances.income_cents,
    income: fromCents(balances.income_cents),
    expense_cents: balances.expense_cents,
    expense: fromCents(balances.expense_cents),
    balance_cents: balances.balance_cents,
    balance: fromCents(balances.balance_cents),
  }
}

/** 月度汇总 -> 对外 JSON（在下发契约字段基础上补元金额，不改 cents 字段）。 */
function summaryDto(summary) {
  return {
    ...summary,
    expense: fromCents(summary.expense_cents),
    income: fromCents(summary.income_cents),
    net: fromCents(summary.net_cents),
    categories: summary.categories.map((row) => ({ ...row, amount: fromCents(row.expense_cents) })),
    largest_expense: summary.largest_expense
      ? { ...summary.largest_expense, amount: fromCents(summary.largest_expense.amount_cents) }
      : null,
    daily: summary.daily.map((row) => ({
      ...row,
      expense: fromCents(row.expense_cents),
      income: fromCents(row.income_cents),
    })),
  }
}

/** 一行账目的中文描述（用于确认预览与结果文案）。 */
function entryLine(dto) {
  const parts = [typeLabel(dto.type), formatCny(dto.amount_cents), dto.category, dto.date]
  if (dto.merchant) parts.push(dto.merchant)
  if (dto.note) parts.push(`备注：${dto.note}`)
  return parts.join(' ｜ ')
}

function normalizeOptionalText(value, field) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw fail(CODES.invalid_argument, `${field} 必须是字符串。`, { field })
  const text = value.trim()
  return text === '' ? null : text
}

/**
 * 校验并规范化一笔待记的账目，产出确认预览用的 draft。
 * 真正落库时 `recordEntry` 会再校验一次，领域层是持久化数据的唯一权威。
 */
function buildEntryDraft(args, today) {
  const { type } = args
  if (type !== 'expense' && type !== 'income') {
    throw fail(CODES.invalid_type, '类型必须是 expense（支出）或 income（收入）。', {
      field: 'type',
      value: type ?? null,
    })
  }

  let amountCents
  try {
    amountCents = toPositiveCents(args.amount, 'amount')
  } catch (error) {
    throw fail(CODES.invalid_amount, `金额必须是大于 0 的元金额（最多两位小数）：${String(args.amount)}`, {
      field: 'amount',
      detail: error.message,
    })
  }

  const category = args.category
  if (typeof category !== 'string' || !CATEGORIES.includes(category)) {
    throw fail(CODES.invalid_category, `分类必须是以下之一：${CATEGORIES.join('、')}`, {
      field: 'category',
      allowed: CATEGORIES,
      value: category ?? null,
    })
  }

  let date = today
  if (args.date !== undefined && args.date !== null && args.date !== '') {
    try {
      date = assertDate(args.date, 'date')
    } catch (error) {
      throw fail(CODES.invalid_date, `日期必须是真实存在的 YYYY-MM-DD：${String(args.date)}`, {
        field: 'date',
        detail: error.message,
      })
    }
  }

  const source = args.source ?? 'text'
  if (!SOURCES.includes(source)) {
    throw fail(CODES.invalid_source, '来源必须是 text（文字录入）或 ocr（小票识别）。', {
      field: 'source',
      value: source ?? null,
    })
  }

  return {
    type,
    amount_cents: amountCents,
    amount: fromCents(amountCents),
    category,
    merchant: normalizeOptionalText(args.merchant, 'merchant'),
    note: normalizeOptionalText(args.note, 'note'),
    date,
    source,
    source_label: SOURCE_LABELS[source],
    type_label: typeLabel(type),
  }
}

/** draft -> 供 `recordEntry` 使用的入参。 */
function draftToEntryInput(draft) {
  return {
    type: draft.type,
    amountYuan: fromCents(draft.amount_cents),
    category: draft.category,
    merchant: draft.merchant,
    note: draft.note,
    date: draft.date,
    source: draft.source,
  }
}

/**
 * 注册 A 模块的 6 个工具。
 * @param {import('@deepseek-ai/cordis').Context} ctx 提供 `ctx.tools.register`
 * @param {{ db: import('node:sqlite').DatabaseSync, config: Record<string, unknown> }} deps
 * @returns {ReturnType<typeof registerJsonTool>[]} 注册的工具定义（测试可用）
 */
export function registerLedgerTools(ctx, { db, config }) {
  const definitions = []

  // 1. 设置初始余额 ──────────────────────────────────────────────────────
  definitions.push(
    registerJsonTool(ctx, {
      name: 'ledger_set_initial_balance',
      description:
        '设置记账的初始余额（单位：元）。初始余额是全部历史结余的起点，记账前必须先设置；' +
        '设置后不会默认按 0 处理。重复设置会报 already_initialized，除非显式传 overwrite=true。',
      parameters: {
        amount: { type: 'number', required: true, description: '初始余额（元），不能为负，最多两位小数' },
        overwrite: { type: 'boolean', description: '已设置过时是否覆盖，默认 false' },
      },
      execute(args) {
        const result = setInitialBalance(db, {
          amountYuan: args.amount,
          today: todayOf(config),
          nowIso: new Date().toISOString(),
          overwrite: args.overwrite === true,
        })
        return okBody({
          initial_balance_cents: result.initial_balance_cents,
          initial_balance: result.initial_balance,
          set_at: result.set_at,
          text:
            `初始余额已设置为 ${formatCny(result.initial_balance_cents)}（${result.set_at}）。` +
            '\n现在可以用 ledger_add_entry 记账了。',
        })
      },
    }),
  )

  // 2. 记一笔账（写操作，需 confirm）──────────────────────────────────────
  definitions.push(
    registerJsonTool(ctx, {
      name: 'ledger_add_entry',
      description:
        '记录一笔支出或收入。写操作需要用户确认：首次调用（confirm 不为 true）只返回预览 draft 与中文说明，' +
        '不会写入数据库；用户确认后再次调用并传 confirm=true 才会落库。金额单位元，内部按整数分存储。' +
        '若尚未设置初始余额会返回 need_initial_balance，请先调用 ledger_set_initial_balance。',
      parameters: {
        type: {
          type: 'string',
          required: true,
          description: '类型：expense=支出，income=收入',
        },
        amount: { type: 'number', required: true, description: '金额（元），必须大于 0，最多两位小数' },
        category: {
          type: 'string',
          required: true,
          description: `分类，必须是：${CATEGORIES.join('、')}`,
        },
        merchant: { type: 'string', description: '商家/对方，可选' },
        date: { type: 'string', description: '日期 YYYY-MM-DD，默认今天（配置时区）' },
        note: { type: 'string', description: '备注，可选' },
        source: { type: 'string', description: '来源：text=文字录入（默认），ocr=小票识别' },
        confirm: { type: 'boolean', description: '是否确认写入，默认 false（仅预览）' },
      },
      execute(args) {
        // 与领域层一致：没有初始余额就不允许进入记账流程（哪怕只是预览）。
        requireInitialBalance(db)
        const draft = buildEntryDraft(args, todayOf(config))
        const preview = entryLine(draft)

        if (args.confirm !== true) {
          return okBody({
            status: 'needs_confirmation',
            draft,
            message:
              `【待确认】${preview}。\n本次未写入账本；确认无误后请再次调用并传 confirm: true。`,
            text: `【待确认】${preview}\n确认后才会写入账本（本次未入库）。`,
          })
        }

        const { entry, balances, month_summary } = recordEntry(db, draftToEntryInput(draft))
        const entryView = entryDto(entry)
        const summary = summaryDto(month_summary)
        return okBody({
          status: 'recorded',
          entry: entryView,
          balances: balancesDto(balances),
          month: summary,
          text:
            `已记入账本：${entryLine(entryView)}。` +
            `\n本月支出 ${formatCny(summary.expense_cents)}（${summary.expense_entry_count} 笔）｜` +
            `本月收入 ${formatCny(summary.income_cents)}（${summary.income_entry_count} 笔）｜` +
            `当前结余 ${formatCny(balances.balance_cents)}。`,
        })
      },
    }),
  )

  // 3. 列账目 ────────────────────────────────────────────────────────────
  definitions.push(
    registerJsonTool(ctx, {
      name: 'ledger_list_entries',
      description: '按月份/类型查询记账记录，按日期倒序返回（金额同时给出元和整数分）。',
      parameters: {
        month: { type: 'string', description: '月份 YYYY-MM，可选；不传则不限月份' },
        type: { type: 'string', description: '类型过滤：expense=支出，income=收入，可选' },
        limit: { type: 'integer', description: '返回条数，默认 50，最大 500' },
      },
      execute(args) {
        const { entries, total } = listEntries(db, {
          month: args.month,
          type: args.type,
          limit: args.limit,
        })
        const list = entries.map(entryDto)
        const lines = list.map((row) => `- ${row.date} ${typeLabel(row.type)} ${formatCny(row.amount_cents)} ${row.category}` +
          `${row.merchant ? ` · ${row.merchant}` : ''}`)
        const text =
          total === 0
            ? '没有符合条件的记账记录。'
            : `共 ${total} 笔记录（本次返回 ${list.length} 笔）：\n${lines.join('\n')}`
        return okBody({ entries: list, total, text })
      },
    }),
  )

  // 4. 删除账目（写操作，需 confirm）──────────────────────────────────────
  definitions.push(
    registerJsonTool(ctx, {
      name: 'ledger_delete_entry',
      description:
        '删除一笔记账记录。写操作需要用户确认：首次调用（confirm 不为 true）只返回待删除记录预览，' +
        '不会删除；用户确认后再次调用并传 confirm=true 才会删除。',
      parameters: {
        id: { type: 'string', required: true, description: '要删除的账目 id' },
        confirm: { type: 'boolean', description: '是否确认删除，默认 false（仅预览）' },
      },
      execute(args) {
        const target = lookupEntry(db, args.id)
        const targetView = entryDto(target)
        const preview = entryLine(targetView)

        if (args.confirm !== true) {
          return okBody({
            status: 'needs_confirmation',
            draft: targetView,
            message: `【待确认】即将删除：${preview}。\n本次未删除；确认无误后请再次调用并传 confirm: true。`,
            text: `【待确认】即将删除：${preview}\n确认后才会删除（本次未改动）。`,
          })
        }

        const { deleted } = deleteEntry(db, { id: args.id })
        return okBody({
          status: 'deleted',
          deleted: entryDto(deleted),
          text: `已删除记账：${entryLine(entryDto(deleted))}。`,
        })
      },
    }),
  )

  // 5. 余额 ──────────────────────────────────────────────────────────────
  definitions.push(
    registerJsonTool(ctx, {
      name: 'ledger_balance',
      description:
        '查询当前结余：初始余额 + 全部历史收入 − 全部历史支出。未设置初始余额时返回 need_initial_balance。',
      parameters: {},
      execute() {
        const balances = balancesDto(getBalances(db))
        return okBody({
          balances,
          text:
            `初始余额 ${formatCny(balances.initial_balance_cents)} ｜ ` +
            `累计收入 ${formatCny(balances.income_cents)} ｜ ` +
            `累计支出 ${formatCny(balances.expense_cents)} ｜ ` +
            `当前结余 ${formatCny(balances.balance_cents)}`,
        })
      },
    }),
  )

  // 6. 月度汇总 ──────────────────────────────────────────────────────────
  definitions.push(
    registerJsonTool(ctx, {
      name: 'ledger_month_summary',
      description:
        '查询某个月的记账汇总：笔数、支出/收入合计、净结余、支出分类占比（前 5 类）、最大单笔支出、每日明细。' +
        '不传月份则用当月。',
      parameters: {
        month: { type: 'string', description: '月份 YYYY-MM，默认当月（配置时区）' },
      },
      execute(args) {
        const month =
          args.month === undefined || args.month === null || args.month === ''
            ? todayOf(config).slice(0, 7)
            : args.month
        const summary = summaryDto(getMonthSummary(db, month))
        const lines = [
          `${summary.month} 月度记账：共 ${summary.entry_count} 笔（支出 ${summary.expense_entry_count} 笔 / 收入 ${summary.income_entry_count} 笔）`,
          `支出合计 ${formatCny(summary.expense_cents)} ｜ 收入合计 ${formatCny(summary.income_cents)} ｜ 净结余 ${formatCny(summary.net_cents)}`,
        ]
        if (summary.categories.length > 0) {
          lines.push('支出分类占比（前 5 类）：')
          for (const row of summary.categories) {
            lines.push(`- ${row.category} ${formatCny(row.expense_cents)}（${row.share ?? '-'}）`)
          }
        }
        if (summary.largest_expense) {
          const largest = summary.largest_expense
          lines.push(
            `最大单笔支出：${largest.date} ${largest.merchant ? `${largest.merchant} ` : ''}${formatCny(largest.amount_cents)}（${largest.category}）`,
          )
        }
        return okBody({ summary, text: lines.join('\n') })
      },
    }),
  )

  return definitions
}

/** 读取一条账目行（用于删除预览）；找不到时抛 entry_not_found。 */
function lookupEntry(db, id) {
  if (typeof id !== 'string' || id.trim() === '') {
    throw fail(CODES.invalid_argument, 'id 必须是非空的账目 id。', { field: 'id' })
  }
  const row = db.prepare('SELECT * FROM ledger_entries WHERE id = ?').get(id.trim())
  if (row === undefined) {
    throw fail(CODES.entry_not_found, `未找到该记账记录：${id.trim()}`, { id: id.trim() })
  }
  return row
}
