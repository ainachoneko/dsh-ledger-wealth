/**
 * Lead-owned core tests: money conversion, date calendar, config validation,
 * SQLite schema isolation and the tool wrapper.
 */

import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { resolveConfig, resolveDbPath, DEFAULT_CONFIG } from '../lib/config.js'
import {
  addDays,
  assertDate,
  assertMonth,
  currentMonth,
  dateInZone,
  daysBetween,
  daysInMonth,
  isMonthEnd,
  monthKeyOf,
  monthRange,
  previousMonth,
} from '../lib/dates.js'
import { getMeta, getMetaInt, newId, openDb, setMeta, TABLES, transaction } from '../lib/db.js'
import { CODES, fail, LedgerError, toToolError } from '../lib/errors.js'
import {
  centsToPlain,
  formatCny,
  formatDeltaCny,
  fromCents,
  percentOf,
  toCents,
  toPositiveCents,
  toSignedCents,
} from '../lib/money.js'
import { okBody, registerJsonTool } from '../lib/toolkit.js'
import { createMemoryDb, createTestContext, testConfig } from './helpers.js'

describe('money', () => {
  it('converts yuan to integer fen', () => {
    assert.equal(toCents('28'), 2800)
    assert.equal(toCents(28.5), 2850)
    assert.equal(toCents('1,234.56'), 123456)
    assert.equal(toCents('0.05'), 5)
    assert.equal(toCents('-3.5'), -350)
    assert.equal(toCents(0), 0)
  })

  it('rejects over-precise, non-finite and non-numeric amounts', () => {
    assert.throws(() => toCents('1.234'), TypeError)
    assert.throws(() => toCents('abc'), TypeError)
    assert.throws(() => toCents(Number.NaN), TypeError)
    assert.throws(() => toCents(Number.POSITIVE_INFINITY), TypeError)
    assert.throws(() => toCents(null), TypeError)
    assert.throws(() => toCents({}), TypeError)
  })

  it('keeps positivity rules separate from signed rules', () => {
    assert.equal(toPositiveCents(0.01), 1)
    assert.throws(() => toPositiveCents(0), TypeError)
    assert.throws(() => toPositiveCents(-1), TypeError)
    assert.equal(toSignedCents(-1.5), -150)
  })

  it('round-trips fen to yuan', () => {
    assert.equal(fromCents(2850), 28.5)
    assert.equal(fromCents(-1), -0.01)
    assert.equal(centsToPlain(123456), '1234.56')
    assert.equal(centsToPlain(-5), '-0.05')
    assert.equal(centsToPlain(0), '0.00')
  })

  it('formats CNY with thousand separators and a signed prefix', () => {
    assert.equal(formatCny(123456), '¥1,234.56')
    assert.equal(formatCny(-123456), '-¥1,234.56')
    assert.equal(formatCny(0), '¥0.00')
    assert.equal(formatCny(100_000_000), '¥1,000,000.00')
    assert.equal(formatDeltaCny(0), '¥0.00')
    assert.equal(formatDeltaCny(500), '+¥5.00')
    assert.equal(formatDeltaCny(-500), '-¥5.00')
  })

  it('computes shares and handles a zero total', () => {
    assert.equal(percentOf(50, 200), '25.0%')
    assert.equal(percentOf(1, 3), '33.3%')
    assert.equal(percentOf(10, 0), null)
  })
})

describe('dates', () => {
  it('resolves today in a time zone', () => {
    // 16:30 UTC is already the next day in Shanghai.
    assert.equal(dateInZone(new Date('2026-10-31T16:30:00Z'), 'Asia/Shanghai'), '2026-11-01')
    assert.equal(dateInZone(new Date('2026-10-31T16:30:00Z'), 'UTC'), '2026-10-31')
    assert.equal(dateInZone(new Date('2026-01-01T00:00:00Z'), 'Asia/Shanghai'), '2026-01-01')
  })

  it('validates real calendar dates', () => {
    assert.equal(assertDate('2026-02-28'), '2026-02-28')
    assert.throws(() => assertDate('2026-02-30'), TypeError)
    assert.throws(() => assertDate('2026-13-01'), TypeError)
    assert.throws(() => assertDate('2026-2-3'), TypeError)
    assert.throws(() => assertDate(20260101), TypeError)
  })

  it('handles month keys, lengths and ranges', () => {
    assert.equal(monthKeyOf('2026-10-05'), '2026-10')
    assert.equal(daysInMonth('2026-02'), 28)
    assert.equal(daysInMonth('2028-02'), 29)
    assert.equal(daysInMonth('2026-10'), 31)
    assert.deepEqual(monthRange('2026-02'), { start: '2026-02-01', end: '2026-02-28' })
    assert.throws(() => assertMonth('2026-13'), TypeError)
    assert.throws(() => daysInMonth('2026-1'), TypeError)
  })

  it('detects the last day of a month', () => {
    assert.equal(isMonthEnd('2026-10-31'), true)
    assert.equal(isMonthEnd('2026-10-30'), false)
    assert.equal(isMonthEnd('2026-02-28'), true)
    assert.equal(isMonthEnd('2028-02-28'), false)
    assert.equal(isMonthEnd('2028-02-29'), true)
  })

  it('walks months and days across boundaries', () => {
    assert.equal(previousMonth('2026-01'), '2025-12')
    assert.equal(previousMonth('2026-10'), '2026-09')
    assert.equal(addDays('2026-01-31', 1), '2026-02-01')
    assert.equal(addDays('2026-03-01', -1), '2026-02-28')
    assert.equal(addDays('2026-10-31', 0), '2026-10-31')
    assert.equal(daysBetween('2026-11-05', '2026-11-30'), 25)
    assert.equal(daysBetween('2026-11-30', '2026-11-05'), -25)
  })

  it('derives the current month in the configured zone', () => {
    assert.equal(currentMonth(new Date('2026-10-31T15:59:00Z'), 'Asia/Shanghai'), '2026-10')
    assert.equal(currentMonth(new Date('2026-10-31T16:01:00Z'), 'Asia/Shanghai'), '2026-11')
  })
})

describe('config', () => {
  const originalDshHome = process.env.DSH_HOME

  beforeEach(() => {
    delete process.env.DSH_HOME
  })

  afterEach(() => {
    if (originalDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = originalDshHome
  })

  it('applies defaults and overrides', () => {
    const config = testConfig()
    assert.equal(config.timeZone, 'Asia/Shanghai')
    assert.equal(config.dailyJobCron, DEFAULT_CONFIG.dailyJobCron)
    assert.equal(config.fundApiEnabled, true)
    assert.equal(config.ocrProvider, 'auto')
    const overridden = testConfig({ timeZone: 'UTC', fundApiEnabled: false, fetchTimeoutMs: 1500 })
    assert.equal(overridden.timeZone, 'UTC')
    assert.equal(overridden.fundApiEnabled, false)
    assert.equal(overridden.fetchTimeoutMs, 1500)
  })

  it('rejects malformed cron, zone, timeout and provider', () => {
    assert.throws(() => resolveConfig({ dailyJobCron: '0 20 * *' }), (error) => error.code === CODES.invalid_config)
    assert.throws(() => resolveConfig({ monthlyJobCron: '@daily' }), (error) => error.code === CODES.invalid_config)
    assert.throws(() => resolveConfig({ timeZone: 'Mars/Olympus' }), (error) => error.code === CODES.invalid_config)
    assert.throws(() => resolveConfig({ fetchTimeoutMs: 10 }), (error) => error.code === CODES.invalid_config)
    assert.throws(() => resolveConfig({ ocrProvider: 'magic' }), (error) => error.code === CODES.invalid_config)
  })

  it('resolves the database path from DSH_HOME or an explicit value', () => {
    // Roots must be absolute *on the running platform*: a literal `D:\...` is not
    // absolute for node:path on the Linux CI runner, so resolve() would leave it relative.
    const fakeHome = join(resolve(tmpdir()), 'fake-dsh-home')
    process.env.DSH_HOME = fakeHome
    assert.equal(
      resolveDbPath(testConfig()).replaceAll('\\', '/'),
      `${fakeHome.replaceAll('\\', '/')}/ledger-wealth/ledger.sqlite`,
    )
    const custom = join(resolve(tmpdir()), 'custom.sqlite')
    assert.equal(resolveDbPath(testConfig({ dbPath: custom })), custom)
  })
})

describe('db', () => {
  it('creates the physical isolation tables', () => {
    const db = createMemoryDb()
    try {
      const names = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => row.name)
        .filter((name) => !name.startsWith('sqlite_'))
        .sort()
      const expected = [...TABLES.ledger, ...TABLES.wealth, ...TABLES.shared].sort()
      assert.deepEqual(names, expected)
      // No table may hold both ledgers.
      assert.ok(!names.includes('transactions'))
      assert.ok(TABLES.ledger.every((name) => !TABLES.wealth.includes(name)))
    } finally {
      db.close()
    }
  })

  it('stores metadata as text and integers', () => {
    const db = createMemoryDb()
    try {
      assert.equal(getMeta(db, 'missing'), undefined)
      assert.equal(getMetaInt(db, 'missing'), null)
      setMeta(db, 'initial_balance_cents', 100000)
      assert.equal(getMeta(db, 'initial_balance_cents'), '100000')
      assert.equal(getMetaInt(db, 'initial_balance_cents'), 100000)
      setMeta(db, 'initial_balance_cents', 250000)
      assert.equal(getMetaInt(db, 'initial_balance_cents'), 250000)
      setMeta(db, 'note', 'not-a-number')
      assert.equal(getMetaInt(db, 'note'), null)
    } finally {
      db.close()
    }
  })

  it('rolls back a failed transaction', () => {
    const db = createMemoryDb()
    try {
      assert.throws(() =>
        transaction(db, () => {
          setMeta(db, 'probe', '1')
          throw new Error('boom')
        }),
      )
      assert.equal(getMeta(db, 'probe'), undefined)
      transaction(db, () => setMeta(db, 'probe', '2'))
      assert.equal(getMeta(db, 'probe'), '2')
    } finally {
      db.close()
    }
  })

  it('enforces the wealth identifier uniqueness per product type', () => {
    const db = createMemoryDb()
    try {
      const insert = (type, identifier) =>
        db
          .prepare(
            `INSERT INTO wealth_products
             (id, product_name, product_type, identifier, holding_amount_cents, last_updated, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(newId('w'), 'p', type, identifier, 1000, '2026-11-05', '2026-11-05T00:00:00Z')
      insert('fund', '000001')
      assert.throws(() => insert('fund', '000001'))
      insert('bank_wealth', '000001')
    } finally {
      db.close()
    }
  })

  it('cascades daily profit deletion with the product', () => {
    const db = createMemoryDb()
    try {
      const productId = newId('w')
      db.prepare(
        `INSERT INTO wealth_products
         (id, product_name, product_type, identifier, holding_amount_cents, last_updated, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(productId, 'p', 'fund', '110022', 5000, '2026-11-05', '2026-11-05T00:00:00Z')
      db.prepare(
        `INSERT INTO wealth_daily_profit (id, product_id, profit_date, amount_cents, source, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(newId('p'), productId, '2026-11-04', 12, 'manual', '2026-11-04T00:00:00Z')
      db.prepare('DELETE FROM wealth_products WHERE id = ?').run(productId)
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM wealth_daily_profit').get().n, 0)
    } finally {
      db.close()
    }
  })

  it('stamps the schema version on a fresh database', () => {
    const db = openDb(':memory:')
    try {
      const version = db.prepare('PRAGMA user_version').get().user_version
      assert.equal(version, 1)
    } finally {
      db.close()
    }
  })
})

describe('errors and toolkit', () => {
  it('maps domain errors to readable results', () => {
    const domain = toToolError(fail(CODES.need_initial_balance, '请先设置初始余额', { field: 'initial_balance' }))
    assert.equal(domain.ok, false)
    assert.equal(domain.code, 'need_initial_balance')
    assert.equal(domain.field, 'initial_balance')
    const internal = toToolError(new Error('kaboom'))
    assert.equal(internal.ok, false)
    assert.equal(internal.code, CODES.internal_error)
    assert.equal(internal.detail, 'kaboom')
    assert.ok(fail('x', 'y') instanceof LedgerError)
  })

  it('registers a tool that succeeds and renders JSON plus text', async () => {
    const { ctx, definitions, render } = createTestContext()
    registerJsonTool(ctx, {
      name: 'demo_ok',
      description: 'demo',
      parameters: { amount: { type: 'number', required: true, description: '金额' } },
      async execute(args) {
        return okBody({ echo_cents: toCents(args.amount), text: '收到' })
      },
    })
    assert.ok(definitions.has('demo_ok'))
    const result = await definitions.get('demo_ok').execute({ amount: 12.5 }, {})
    assert.deepEqual(result, { ok: true, echo_cents: 1250, text: '收到' })
    const blocks = render('demo_ok', { amount: 12.5 }, result)
    assert.equal(blocks.length, 2)
    assert.deepEqual(JSON.parse(blocks[0].text), { ok: true, echo_cents: 1250 })
    assert.equal(blocks[1].text, '收到')
  })

  it('never throws out of execute', async () => {
    const { ctx, definitions } = createTestContext()
    registerJsonTool(ctx, {
      name: 'demo_fail',
      description: 'demo',
      async execute() {
        throw fail(CODES.invalid_amount, '金额无效')
      },
    })
    const result = await definitions.get('demo_fail').execute({}, {})
    assert.equal(result.ok, false)
    assert.equal(result.code, 'invalid_amount')
  })
})
