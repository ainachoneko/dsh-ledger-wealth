/**
 * SQLite persistence for the plugin. Uses the host's built-in `node:sqlite`
 * (Electron 44 / Node 24), so no native addon or install step is required.
 *
 * Ledger money and wealth money live in physically separate tables. There is no
 * view, join or column that adds one to the other: reports read both tables and
 * render them in separate sections.
 * @module dsh-ledger-wealth/db
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** Bump together with a new entry in MIGRATIONS. */
export const SCHEMA_VERSION = 1

const MIGRATIONS = {
  1: `
  -- ── shared metadata (initial balance, schema bookkeeping) ──────────────
  CREATE TABLE IF NOT EXISTS meta (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- ── A. 日常记账 ────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS ledger_entries (
    id           TEXT PRIMARY KEY,
    entry_date   TEXT NOT NULL,
    type         TEXT NOT NULL CHECK (type IN ('expense', 'income')),
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    category     TEXT NOT NULL,
    merchant     TEXT,
    note         TEXT,
    source       TEXT NOT NULL CHECK (source IN ('text', 'ocr')),
    created_at   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ledger_entries_date ON ledger_entries (entry_date);
  CREATE INDEX IF NOT EXISTS idx_ledger_entries_type ON ledger_entries (type);

  -- ── B. 理财持仓 ────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS wealth_products (
    id                         TEXT PRIMARY KEY,
    product_name               TEXT NOT NULL,
    product_type               TEXT NOT NULL CHECK (product_type IN ('fund', 'bank_wealth', 'other')),
    identifier                 TEXT NOT NULL,
    holding_amount_cents       INTEGER NOT NULL CHECK (holding_amount_cents >= 0),
    shares                     REAL,
    cost_nav                   REAL,
    manual_daily_profit_cents  INTEGER,
    manual_total_profit_cents  INTEGER,
    buy_date                   TEXT,
    redeem_date                TEXT,
    active                     INTEGER NOT NULL DEFAULT 1,
    last_updated               TEXT NOT NULL,
    created_at                 TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_wealth_products_identifier
    ON wealth_products (product_type, identifier);

  CREATE TABLE IF NOT EXISTS wealth_daily_profit (
    id           TEXT PRIMARY KEY,
    product_id   TEXT NOT NULL REFERENCES wealth_products (id) ON DELETE CASCADE,
    profit_date  TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    source       TEXT NOT NULL CHECK (source IN ('manual', 'api', 'estimated', 'stale')),
    nav_date     TEXT,
    detail       TEXT,
    fetched_at   TEXT NOT NULL,
    UNIQUE (product_id, profit_date)
  );
  CREATE INDEX IF NOT EXISTS idx_wealth_daily_profit_date
    ON wealth_daily_profit (profit_date);

  -- ── jobs / reports / alerts (idempotency + delivery bookkeeping) ────────
  CREATE TABLE IF NOT EXISTS job_runs (
    job_key  TEXT PRIMARY KEY,
    kind     TEXT NOT NULL,
    status   TEXT NOT NULL,
    summary  TEXT,
    ran_at   TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS monthly_reports (
    month        TEXT PRIMARY KEY,
    ledger_json  TEXT NOT NULL,
    wealth_json  TEXT NOT NULL,
    rendered     TEXT NOT NULL,
    created_at   TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS alerts (
    id         TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    module     TEXT NOT NULL,
    level      TEXT NOT NULL,
    message    TEXT NOT NULL,
    resolved   INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts (created_at);
  `,
}

/** Run `fn` inside one write transaction and roll back on throw. */
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const value = fn()
    db.exec('COMMIT')
    return value
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* the original error is the useful one */
    }
    throw error
  }
}

function migrate(db) {
  const row = db.prepare('PRAGMA user_version').get()
  let version = Number(row?.user_version ?? 0)
  const targets = Object.keys(MIGRATIONS).map(Number).sort((a, b) => a - b)
  for (const target of targets) {
    if (version >= target) continue
    // PRAGMA cannot be parameterized; the value is a literal from our own map.
    db.exec(MIGRATIONS[target])
    db.exec(`PRAGMA user_version = ${target}`)
    version = target
  }
}

/**
 * Open (and migrate) the ledger database.
 * @param {string} dbPath absolute path, or ':memory:' in tests
 * @returns {DatabaseSync}
 */
export function openDb(dbPath = ':memory:') {
  if (dbPath !== ':memory:') mkdirSync(dirname(resolve(dbPath)), { recursive: true })
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  if (dbPath !== ':memory:') db.exec('PRAGMA journal_mode = WAL')
  migrate(db)
  return db
}

/** New opaque id with a readable prefix. */
export function newId(prefix) {
  return `${prefix}-${randomUUID()}`
}

/** Read one metadata value, or undefined. */
export function getMeta(db, key) {
  return db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value
}

/** Upsert one metadata value. */
export function setMeta(db, key, value, nowIso = new Date().toISOString()) {
  db.prepare(
    `INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, String(value), nowIso)
}

/** Read an integer metadata value, or null. */
export function getMetaInt(db, key) {
  const raw = getMeta(db, key)
  if (raw === undefined) return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

/** Table names owned by each module — used by tests to prove physical isolation. */
export const TABLES = {
  ledger: ['ledger_entries'],
  wealth: ['wealth_products', 'wealth_daily_profit'],
  shared: ['meta', 'job_runs', 'monthly_reports', 'alerts'],
}
