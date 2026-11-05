/**
 * Plugin entry for dsh-ledger-wealth.
 *
 * Registers the ledger (记账) tools, the wealth (理财) tools, the optional OCR
 * tool, the job/schedule tools and the report tools. Both money modules share
 * one SQLite file but never share a table, a total or a report section.
 * @module dsh-ledger-wealth
 */

import { resolveConfig, resolveDbPath, todayInZone } from './config.js'
import { openDb } from './db.js'
import { registerJobsTools } from './tools/jobs.js'
import { registerLedgerTools } from './tools/ledger.js'
import { registerOcrTools } from './tools/ocr.js'
import { registerReportTools } from './tools/report.js'
import { registerWealthTools } from './tools/wealth.js'

/** Cordis plugin name (must match the `name` field in cordis.patch.yml). */
export const name = 'dsh-ledger-wealth'

/** Services this plugin requires before it is mounted. */
export const inject = ['tools']

/**
 * Mount the plugin.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} [rawConfig]
 */
export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig)
  const dbPath = resolveDbPath(config)
  const db = openDb(dbPath)

  ctx.effect(() => () => {
    try {
      db.close()
    } catch {
      /* already closed */
    }
  })

  const deps = {
    db,
    dbPath,
    config,
    timeZone: config.timeZone,
    today: () => todayInZone(config),
  }

  registerLedgerTools(ctx, deps)
  registerWealthTools(ctx, deps)
  registerOcrTools(ctx, deps)
  registerJobsTools(ctx, deps)
  registerReportTools(ctx, deps)

  ctx.logger?.info?.(`[ledger-wealth] ready · db=${dbPath} · tz=${config.timeZone}`)
}
