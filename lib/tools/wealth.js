/**
 * B 模块工具层：把 `lib/wealth.js` + `lib/profit.js` 的能力注册成模型可调用的 JSON 工具。
 *
 * 约定（与 A 模块一致）：
 * - 一律用 `lib/toolkit.js` 的 `registerJsonTool` 注册；领域层抛 `LedgerError`，
 *   toolkit 统一转成 `{ ok:false, code, message }`，本文件不自己拼错误对象。
 * - 写操作（录入 / 修改 / 手填收益）必须 `confirm === true` 才落库；否则只回
 *   `{ ok:true, status:'needs_confirmation', draft, message }` 预览。
 * - 理财金额永远只出现在理财工具的输出里，**不与记账金额相加**。
 * @module dsh-ledger-wealth/tools/wealth
 */

import { addDays, dateInZone } from '../dates.js'
import { CODES, fail } from '../errors.js'
import { formatCny, formatDeltaCny, fromCents, toSignedCents } from '../money.js'
import { refreshDailyProfits } from '../profit.js'
import { okBody, registerJsonTool } from '../toolkit.js'
import {
  addProduct,
  getWealthSummary,
  listProducts,
  recordDailyProfit,
  updateProduct,
} from '../wealth.js'

const TYPE_LABELS = { fund: '基金', bank_wealth: '银行理财', other: '其他' }
const SOURCE_LABELS = {
  manual: '手动填写',
  api: '数据源实时数据',
  estimated: '涨跌幅估算',
  stale: '沿用上次值（非实时）',
}

function typeLabel(type) {
  return TYPE_LABELS[type] ?? String(type ?? '未知')
}

function sourceLabel(source) {
  return SOURCE_LABELS[source] ?? String(source ?? '未知')
}

/** 当前日期（按配置时区）。 */
function todayOf(config) {
  return dateInZone(new Date(), config?.timeZone ?? 'Asia/Shanghai')
}

/** 金额（元）-> 整数分，失败抛稳定的 invalid_amount。 */
function signedCents(value, field) {
  try {
    return toSignedCents(value, field)
  } catch (error) {
    throw fail(CODES.invalid_amount, `${field} 金额不合法：${error.message}`, { field })
  }
}

/** 产品的一行中文摘要（确认预览 / 结果文案共用）。 */
function productLine(product) {
  const parts = [typeLabel(product.product_type), product.identifier, formatCny(product.holding_amount_cents)]
  if (product.shares !== null && product.shares !== undefined) parts.push(`${product.shares} 份`)
  if (product.redeem_date) parts.push(`到期 ${product.redeem_date}`)
  return `${product.product_name}｜${parts.join(' ｜ ')}`
}

/** 把工具参数的蛇形字段映射成领域层 patch 的驼峰键（只传用户给了的字段）。 */
const PATCH_KEYS = {
  product_name: 'product_name',
  holding_amount: 'holdingAmountYuan',
  shares: 'shares',
  cost_nav: 'costNav',
  manual_daily_profit: 'manualDailyProfitYuan',
  manual_total_profit: 'manualTotalProfitYuan',
  buy_date: 'buyDate',
  redeem_date: 'redeemDate',
  active: 'active',
}

function buildPatch(args) {
  const patch = {}
  for (const [from, to] of Object.entries(PATCH_KEYS)) {
    if (Object.hasOwn(args, from) && args[from] !== undefined) patch[to] = args[from]
  }
  if (Object.keys(patch).length === 0) {
    throw fail(CODES.invalid_argument, '没有要修改的字段：至少传一个可改字段。', { field: 'patch' })
  }
  return patch
}

/**
 * 注册理财模块的全部工具。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{db: import('node:sqlite').DatabaseSync, config: object, today?: () => string}} deps
 */
export function registerWealthTools(ctx, deps) {
  const { db, config } = deps
  const definitions = []

  // 1. 录入持仓（写操作，需 confirm）──────────────────────────────────────
  definitions.push(
    registerJsonTool(ctx, {
      name: 'wealth_add_product',
      description:
        '录入一个理财持仓（基金 / 银行理财 / 其他）。写操作需要用户确认：首次调用（confirm 不为 true）只返回待录入预览，' +
        '不落库；用户确认后再次调用并传 confirm=true 才写入。理财产品用 6 位基金代码作为 identifier。',
      parameters: {
        product_name: { type: 'string', required: true, description: '产品名称，例如「华夏成长混合」' },
        product_type: {
          type: 'string',
          required: true,
          enum: ['fund', 'bank_wealth', 'other'],
          description: '产品类型：fund 基金 / bank_wealth 银行理财 / other 其他',
        },
        identifier: { type: 'string', required: true, description: '产品标识：基金填 6 位代码，其他填账户内唯一标识' },
        holding_amount: { type: 'number', required: true, description: '持仓金额（元，大于 0）' },
        shares: { type: 'number', description: '持有份额（基金建议填，用于按真实净值差算收益）' },
        cost_nav: { type: 'number', description: '成本净值（元/份，仅记录）' },
        manual_daily_profit: { type: 'number', description: '手动填写的每日收益（元，填了就优先用它，不再取数）' },
        manual_total_profit: { type: 'number', description: '手动填写的累计收益（元，填了就用它当累计收益）' },
        buy_date: { type: 'string', description: '买入日期 YYYY-MM-DD' },
        redeem_date: { type: 'string', description: '到期/赎回日期 YYYY-MM-DD（用于到期提醒）' },
        confirm: { type: 'boolean', description: '是否确认写入，默认 false（仅预览）' },
      },
      execute(args) {
        const payload = {
          product_name: args.product_name,
          product_type: args.product_type,
          identifier: args.identifier,
          holdingAmountYuan: args.holding_amount,
          shares: args.shares,
          costNav: args.cost_nav,
          manualDailyProfitYuan: args.manual_daily_profit,
          manualTotalProfitYuan: args.manual_total_profit,
          buyDate: args.buy_date,
          redeemDate: args.redeem_date,
          today: todayOf(config),
        }

        if (args.confirm !== true) {
          return okBody({
            status: 'needs_confirmation',
            draft: {
              product_name: payload.product_name,
              product_type: payload.product_type,
              identifier: payload.identifier,
              holding_amount: payload.holdingAmountYuan,
              shares: payload.shares ?? null,
              cost_nav: payload.costNav ?? null,
              manual_daily_profit: payload.manualDailyProfitYuan ?? null,
              manual_total_profit: payload.manualTotalProfitYuan ?? null,
              buy_date: payload.buyDate ?? null,
              redeem_date: payload.redeemDate ?? null,
            },
            message:
              '【待确认】即将录入理财持仓：' +
              `${payload.product_name}（${typeLabel(payload.product_type)} ${payload.identifier}，` +
              `持仓 ${payload.holdingAmountYuan} 元）。本次未写入；确认无误后请再次调用并传 confirm: true。`,
            text:
              `【待确认】${payload.product_name}（${typeLabel(payload.product_type)} ${payload.identifier} ` +
              `${payload.holdingAmountYuan} 元）\n确认后才会写入（本次未改动）。`,
          })
        }

        const { product } = addProduct(db, payload)
        return okBody({
          status: 'recorded',
          product,
          text: `已录入理财持仓：${productLine(product)}。`,
        })
      },
    }),
  )

  // 2. 修改持仓（写操作，需 confirm）──────────────────────────────────────
  definitions.push(
    registerJsonTool(ctx, {
      name: 'wealth_update_product',
      description:
        '修改一个理财持仓（名称/持仓金额/份额/成本净值/手动收益/日期/是否持有）。只传要改的字段。' +
        '传 null 或空字符串表示清空该字段。写操作需要确认：confirm 不为 true 时只返回预览。',
      parameters: {
        id: { type: 'string', required: true, description: '产品 id（用 wealth_list_products 查）' },
        product_name: { type: 'string', description: '新的产品名称' },
        holding_amount: { type: 'number', description: '新的持仓金额（元）' },
        shares: { type: 'number', description: '新的持有份额' },
        cost_nav: { type: 'number', description: '新的成本净值' },
        manual_daily_profit: { type: 'number', description: '手动每日收益（元）' },
        manual_total_profit: { type: 'number', description: '手动累计收益（元）' },
        buy_date: { type: 'string', description: '买入日期 YYYY-MM-DD' },
        redeem_date: { type: 'string', description: '到期/赎回日期 YYYY-MM-DD' },
        active: { type: 'boolean', description: 'false 表示归档（不再计入持仓）' },
        confirm: { type: 'boolean', description: '是否确认写入，默认 false（仅预览）' },
      },
      execute(args) {
        const patch = buildPatch(args)
        const preview = { id: args.id, patch }

        if (args.confirm !== true) {
          return okBody({
            status: 'needs_confirmation',
            draft: preview,
            message: `【待确认】即将修改理财持仓 ${args.id}：${Object.keys(patch).join('、')}。本次未写入；确认后请再次调用并传 confirm: true。`,
            text: `【待确认】修改 ${args.id} 的 ${Object.keys(patch).join('、')}\n确认后才会写入（本次未改动）。`,
          })
        }

        const { product } = updateProduct(db, { id: args.id, patch, today: todayOf(config) })
        return okBody({
          status: 'updated',
          product,
          text: `已更新理财持仓：${productLine(product)}。`,
        })
      },
    }),
  )

  // 3. 列出持仓（只读）────────────────────────────────────────────────────
  definitions.push(
    registerJsonTool(ctx, {
      name: 'wealth_list_products',
      description: '列出理财产品持仓（默认只看在持的；include_archived=true 时连已归档的一起列出）。',
      parameters: {
        include_archived: { type: 'boolean', description: '是否包含已归档产品，默认 false' },
      },
      execute(args) {
        const active = args.include_archived === true ? null : true
        const { products } = listProducts(db, { active })
        const holdingCents = products.reduce((sum, item) => sum + item.holding_amount_cents, 0)
        const lines = products.map((item) => `- ${productLine(item)}`)
        return okBody({
          products,
          count: products.length,
          holding_total_cents: holdingCents,
          text:
            products.length === 0
              ? '目前没有在持的理财产品。'
              : `在持理财 ${products.length} 个，持仓合计 ${formatCny(holdingCents)}：\n${lines.join('\n')}`,
        })
      },
    }),
  )

  // 4. 手动记一笔收益（写操作，需 confirm）────────────────────────────────
  definitions.push(
    registerJsonTool(ctx, {
      name: 'wealth_record_profit',
      description:
        '手动记录某个产品某一天的收益（元，可为负）。同日重复记录会覆盖（幂等），来源标记为 manual。' +
        '写操作需要确认：confirm 不为 true 时只返回预览。',
      parameters: {
        product_id: { type: 'string', required: true, description: '产品 id' },
        amount: { type: 'number', required: true, description: '当日收益（元，可为负数）' },
        profit_date: { type: 'string', description: '收益日期 YYYY-MM-DD，默认今天（配置时区）' },
        note: { type: 'string', description: '备注，例如「APP 上看到的数字」' },
        confirm: { type: 'boolean', description: '是否确认写入，默认 false（仅预览）' },
      },
      execute(args) {
        const amountCents = signedCents(args.amount, 'amount')
        const profitDate =
          args.profit_date === undefined || args.profit_date === null || args.profit_date === ''
            ? todayOf(config)
            : args.profit_date
        const note = typeof args.note === 'string' && args.note.trim() !== '' ? args.note.trim() : null

        if (args.confirm !== true) {
          return okBody({
            status: 'needs_confirmation',
            draft: { product_id: args.product_id, profit_date: profitDate, amount: args.amount, note },
            message:
              `【待确认】即将记录 ${profitDate} 的收益 ${formatDeltaCny(amountCents)}（产品 ${args.product_id}）。` +
              '本次未写入；确认后请再次调用并传 confirm: true。',
            text: `【待确认】${profitDate} 收益 ${formatDeltaCny(amountCents)}\n确认后才会写入（本次未改动）。`,
          })
        }

        const { profit, replaced } = recordDailyProfit(db, {
          productId: args.product_id,
          profitDate,
          amountCents,
          source: 'manual',
          navDate: profitDate,
          detail: note ?? '手动填写',
        })
        return okBody({
          status: replaced ? 'replaced' : 'recorded',
          profit: { ...profit, amount: fromCents(profit.amount_cents) },
          text: `${replaced ? '已覆盖' : '已记录'} ${profitDate} 的收益 ${formatDeltaCny(profit.amount_cents)}（手动填写）。`,
        })
      },
    }),
  )

  // 5. 跑降级链刷新收益（写操作，但写的是「取到的真实值」，不需要确认）──
  definitions.push(
    registerJsonTool(ctx, {
      name: 'wealth_refresh_profit',
      description:
        '按降级链刷新某个日期（默认今天）的收益：手动值 → 基金真实净值差 → 涨跌幅估算 → 沿用上次值。' +
        '取不到就明确报告缺失，绝不编造。不传 product_id 则刷新全部在持产品。',
      parameters: {
        profit_date: { type: 'string', description: '收益日期 YYYY-MM-DD，默认今天（配置时区）' },
        product_id: { type: 'string', description: '只刷新这一个产品；省略则刷新全部在持产品' },
      },
      async execute(args) {
        const profitDate =
          args.profit_date === undefined || args.profit_date === null || args.profit_date === ''
            ? todayOf(config)
            : args.profit_date

        if (args.product_id === undefined || args.product_id === null || args.product_id === '') {
          const result = await refreshDailyProfits(db, { profitDate, config })
          const lines = [
            `${profitDate} 理财收益刷新：成功 ${result.updated.length} 个，缺失 ${result.missing.length} 个。`,
          ]
          for (const item of result.updated) {
            lines.push(`- ${item.product_name} ${formatDeltaCny(item.amount_cents)}（${sourceLabel(item.source)}）`)
          }
          for (const item of result.missing) {
            lines.push(`- ${item.product_name} 无数据：${item.reason}`)
          }
          for (const alert of result.alerts) lines.push(`！${alert.message}`)
          return okBody({ result, text: lines.join('\n') })
        }

        // 单产品：复用同一条降级链，但不落库整批。
        const { products } = listProducts(db, { active: null })
        const product = products.find((item) => item.id === args.product_id)
        if (!product) throw fail(CODES.product_not_found, `理财产品不存在：${args.product_id}`, { id: args.product_id })
        const { resolveDailyProfit } = await import('../profit.js')
        const resolved = await resolveDailyProfit({ product, profitDate, config })
        if (resolved.status !== 'ok' || resolved.profit === null) {
          return okBody({
            status: 'unavailable',
            profit_date: profitDate,
            product_id: product.id,
            reason: resolved.reason,
            attempts: resolved.attempts,
            text: `${product.product_name} 在 ${profitDate} 没有可用收益数据（${resolved.reason}），已跳过，未写入。`,
          })
        }
        const { profit, replaced } = recordDailyProfit(db, {
          productId: product.id,
          profitDate,
          amountCents: resolved.profit.amount_cents,
          source: resolved.profit.source,
          navDate: resolved.profit.nav_date,
          detail: resolved.profit.detail,
        })
        return okBody({
          status: replaced ? 'replaced' : 'recorded',
          profit_date: profitDate,
          product_id: product.id,
          profit: { ...profit, amount: fromCents(profit.amount_cents) },
          attempts: resolved.attempts,
          text:
            `${product.product_name} ${profitDate} 收益 ${formatDeltaCny(profit.amount_cents)}` +
            `（${sourceLabel(profit.source)}）：${resolved.profit.detail ?? ''}`,
        })
      },
    }),
  )

  // 6. 理财月度汇总（只读）────────────────────────────────────────────────
  definitions.push(
    registerJsonTool(ctx, {
      name: 'wealth_summary',
      description:
        '理财月度汇总：各产品本月收益、累计收益、数据来源、缺失产品、7 天内到期提醒。' +
        '**只统计理财模块**，不与记账结余合并。不传月份则用当月。',
      parameters: {
        month: { type: 'string', description: '月份 YYYY-MM，默认当月（配置时区）' },
      },
      execute(args) {
        const today = todayOf(config)
        const month =
          args.month === undefined || args.month === null || args.month === '' ? today.slice(0, 7) : args.month
        const summary = getWealthSummary(db, { month, today })
        const lines = [
          `${summary.month} 理财汇总：在持 ${summary.products.length} 个，持仓合计 ${formatCny(summary.totals.holding_cents)}`,
          `本月收益合计 ${formatDeltaCny(summary.totals.month_profit_cents)} ｜ 累计收益 ${formatDeltaCny(summary.totals.total_profit_cents)}`,
        ]
        for (const item of summary.products) {
          const stale = item.stale ? '（沿用上次值，非实时）' : ''
          const source = item.last_profit ? sourceLabel(item.last_profit.source) : '无记录'
          lines.push(
            `- ${item.product_name}｜持仓 ${formatCny(item.holding_amount_cents)}｜本月 ${formatDeltaCny(item.month_profit_cents)}` +
              `｜累计 ${formatDeltaCny(item.total_profit_cents)}（${item.total_profit_source === 'manual' ? '手动累计' : '按日累加'}）` +
              `｜${source}${stale}`,
          )
        }
        if (summary.missing_products.length > 0) {
          lines.push(`缺失收益数据 ${summary.missing_product_count} 个：`)
          for (const item of summary.missing_products) lines.push(`- ${item.product_name}：${item.reason}`)
        }
        if (summary.expiring.length > 0) {
          lines.push('7 天内到期：')
          for (const item of summary.expiring) {
            lines.push(`- ${item.product_name} ${item.redeem_date}（还剩 ${item.days_left} 天）`)
          }
        }
        return okBody({ summary, text: lines.join('\n') })
      },
    }),
  )

  return definitions
}

/** 供调度层构造「昨天」这类默认值（导出便于测试）。 */
export function yesterdayInZone(config) {
  return addDays(todayOf(config), -1)
}
