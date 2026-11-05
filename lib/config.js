/**
 * Plugin configuration: defaults, validation and path resolution.
 * @module dsh-ledger-wealth/config
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { dateInZone } from './dates.js'
import { CODES, fail } from './errors.js'

/** Supported OCR providers. */
export const OCR_PROVIDERS = ['auto', 'command', 'rapidocr', 'none']

/** Default plugin configuration; the bundle patch mirrors these values. */
export const DEFAULT_CONFIG = {
  /** Absolute SQLite path. Empty string => default under the DSH home directory. */
  dbPath: '',
  /** IANA zone used for "today", month boundaries and job prompts. */
  timeZone: 'Asia/Shanghai',
  /** Five-field Vixie cron for the daily profit job (after close). */
  dailyJobCron: '0 20 * * *',
  /** Five-field Vixie cron for the month-end probe (runs daily near 21:00, guarded by isMonthEnd). */
  monthlyJobCron: '0 21 28-31 * *',
  /** Network timeout for one source lookup, milliseconds. */
  fetchTimeoutMs: 8000,
  /** Enable the public fund NAV source (eastmoney). */
  fundApiEnabled: true,
  /** Enable the bank-wealth source (currently no free coverage; keeps the chain explicit). */
  bankApiEnabled: true,
  /** OCR provider selection: auto | command | rapidocr | none. */
  ocrProvider: 'auto',
  /** Optional external OCR CLI; must print recognized text to stdout. */
  ocrCommand: '',
  /** Optional python executable of a venv with rapidocr_onnxruntime installed. */
  ocrVenvPython: '',
  /** OCR subprocess timeout, milliseconds. */
  ocrTimeoutMs: 30000,
}

const CRON_RE = /^\s*(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s*$/

/** Expand `~` / `%VAR%`-free simple paths and make them absolute. */
export function expandPath(value) {
  const text = String(value).trim()
  if (text === '~') return homedir()
  if (text.startsWith('~/') || text.startsWith('~\\')) return join(homedir(), text.slice(2))
  return resolve(text)
}

/** Default directory for the plugin database: `<DSH_HOME>/ledger-wealth`. */
export function defaultDataDir() {
  const dshHome = process.env.DSH_HOME?.trim() ? expandPath(process.env.DSH_HOME) : join(homedir(), '.dsh')
  return join(dshHome, 'ledger-wealth')
}

/** Resolve the effective SQLite path from a config object. */
export function resolveDbPath(config) {
  if (typeof config?.dbPath === 'string' && config.dbPath.trim() !== '') return expandPath(config.dbPath)
  return join(defaultDataDir(), 'ledger.sqlite')
}

function assertCron(value, field) {
  if (typeof value !== 'string' || !CRON_RE.test(value)) {
    throw fail(CODES.invalid_config, `${field} 必须是五段 cron 表达式，例如 "0 20 * * *"`, { field })
  }
  return value.trim()
}

function assertTimeZone(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw fail(CODES.invalid_config, 'timeZone 必须是非空 IANA 时区，例如 Asia/Shanghai', { field: 'timeZone' })
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date(0))
  } catch {
    throw fail(CODES.invalid_config, `无法识别的时区：${value}`, { field: 'timeZone' })
  }
  return value
}

/**
 * Merge user config with defaults and validate it.
 * @param {Record<string, unknown>} [raw]
 * @returns {typeof DEFAULT_CONFIG}
 */
export function resolveConfig(raw = {}) {
  const config = { ...DEFAULT_CONFIG }
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (value !== undefined && value !== null) config[key] = value
  }
  config.timeZone = assertTimeZone(config.timeZone)
  config.dailyJobCron = assertCron(config.dailyJobCron, 'dailyJobCron')
  config.monthlyJobCron = assertCron(config.monthlyJobCron, 'monthlyJobCron')
  const timeout = Number(config.fetchTimeoutMs)
  if (!Number.isFinite(timeout) || timeout < 500 || timeout > 120000) {
    throw fail(CODES.invalid_config, 'fetchTimeoutMs 必须在 500..120000 毫秒之间', { field: 'fetchTimeoutMs' })
  }
  config.fetchTimeoutMs = Math.round(timeout)
  const ocrTimeout = Number(config.ocrTimeoutMs)
  if (!Number.isFinite(ocrTimeout) || ocrTimeout < 1000 || ocrTimeout > 600000) {
    throw fail(CODES.invalid_config, 'ocrTimeoutMs 必须在 1000..600000 毫秒之间', { field: 'ocrTimeoutMs' })
  }
  config.ocrTimeoutMs = Math.round(ocrTimeout)
  config.fundApiEnabled = config.fundApiEnabled !== false
  config.bankApiEnabled = config.bankApiEnabled !== false
  if (!OCR_PROVIDERS.includes(config.ocrProvider)) {
    throw fail(CODES.invalid_config, `ocrProvider 必须是 ${OCR_PROVIDERS.join(' | ')}`, { field: 'ocrProvider' })
  }
  for (const field of ['dbPath', 'ocrCommand', 'ocrVenvPython']) {
    if (typeof config[field] !== 'string') {
      throw fail(CODES.invalid_config, `${field} 必须是字符串`, { field })
    }
  }
  return config
}

/** Today's date in the configured zone (thin re-export for convenience). */
export function todayInZone(config, now = new Date()) {
  return dateInZone(now, config.timeZone)
}
