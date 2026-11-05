/**
 * 集成测试：像宿主那样调用 `apply(ctx, config)`，确认整包能装配起来。
 *
 * 这一层是「装得上、能跑」的最小证明：工具全部注册、数据库落在指定路径、
 * 记账与理财两条链路互不串台、关闭时释放连接。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { apply } from '../lib/index.js'
import { createTestContext } from './helpers.js'

const CASH_TOOLS = [
  'ledger_set_initial_balance',
  'ledger_add_entry',
  'ledger_list_entries',
  'ledger_delete_entry',
  'ledger_balance',
  'ledger_month_summary',
]

const WEALTH_TOOLS = [
  'wealth_add_product',
  'wealth_update_product',
  'wealth_list_products',
  'wealth_record_profit',
  'wealth_refresh_profit',
  'wealth_summary',
]

const OPS_TOOLS = ['ledger_scan_receipt', 'finance_run_daily_job', 'finance_run_month_end_job', 'finance_setup_schedules', 'finance_schedule_status', 'finance_monthly_report', 'finance_alerts', 'finance_status']

describe('plugin assembly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ledger-wealth-'))
  after(() => {
    // Windows 上 sqlite 句柄可能比测试晚一步释放，删不掉就留给系统临时目录。
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 忽略清理失败 */
    }
  })

  it('mounts every tool and keeps one SQLite file for both modules', async (t) => {
    const dbPath = join(dir, 'ledger.sqlite')
    const env = createTestContext()
    apply(env.ctx, { dbPath, timeZone: 'Asia/Shanghai' })
    t.after(() => env.dispose())

    for (const name of [...CASH_TOOLS, ...WEALTH_TOOLS, ...OPS_TOOLS]) {
      assert.ok(env.definitions.has(name), `缺少工具：${name}`)
    }
    assert.equal(env.definitions.size, CASH_TOOLS.length + WEALTH_TOOLS.length + OPS_TOOLS.length)
    assert.ok(existsSync(dbPath), '数据库文件必须落在配置的路径上')

    // 记账链路：初始余额 -> 记账（两步确认）
    const balance = await env.call('ledger_balance', {})
    assert.equal(balance.ok, false)
    assert.equal(balance.code, 'need_initial_balance')

    await env.call('ledger_set_initial_balance', { amount: 5000 })
    const preview = await env.call('ledger_add_entry', {
      type: 'expense',
      amount: 28,
      category: '餐饮',
      merchant: 'Manner',
      date: '2026-10-05',
    })
    assert.equal(preview.status, 'needs_confirmation')
    const recorded = await env.call('ledger_add_entry', {
      type: 'expense',
      amount: 28,
      category: '餐饮',
      merchant: 'Manner',
      date: '2026-10-05',
      confirm: true,
    })
    assert.equal(recorded.status, 'recorded')
    const after = await env.call('ledger_balance', {})
    assert.equal(after.balances.balance_cents, 500000 - 2800)

    // 理财链路：录入（两步确认）+ 手动收益
    const product = await env.call('wealth_add_product', {
      product_name: '华夏成长混合',
      product_type: 'fund',
      identifier: '000001',
      holding_amount: 10000,
      shares: 5000,
      confirm: true,
    })
    assert.equal(product.status, 'recorded')
    const profit = await env.call('wealth_record_profit', {
      product_id: product.product.id,
      amount: 1.25,
      profit_date: '2026-10-30',
      confirm: true,
    })
    assert.equal(profit.ok, true)

    // 隔离：理财汇总只说理财，记账汇总只说记账
    const wealth = await env.call('wealth_summary', { month: '2026-10' })
    const cash = await env.call('ledger_month_summary', { month: '2026-10' })
    assert.doesNotMatch(wealth.text, /结余|支出合计/)
    assert.doesNotMatch(cash.text, /持仓|本月收益合计/)
    assert.equal(wealth.summary.totals.month_profit_cents, 125)
    assert.equal(cash.summary.expense_cents, 2800)
  })

  it('closes the database when the plugin is disposed', async (t) => {
    const dbPath = join(dir, 'dispose.sqlite')
    const env = createTestContext()
    apply(env.ctx, { dbPath })
    const before = await env.call('ledger_balance', {})
    assert.equal(before.ok, false)
    env.dispose()
    // 释放后再打开同一个文件不应卡住（WAL 已被正常关闭）
    const second = createTestContext()
    apply(second.ctx, { dbPath })
    t.after(() => second.dispose())
    const again = await second.call('ledger_balance', {})
    assert.equal(again.code, 'need_initial_balance')
  })
})
