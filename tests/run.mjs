/**
 * In-process test runner.
 *
 * `node --test` spawns one child process per file, which the DSH Windows
 * sandbox denies (spawn EPERM, because the runner captures piped stdio).
 * Importing the test files here runs the same node:test suites in one process,
 * so `node tests/run.mjs` works both locally and inside the sandbox.
 *
 * Files that do not exist yet (while a module is still being written by another
 * owner) are reported as skipped instead of failing the run.
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

const FILES = [
  'core.test.js',
  'ledger.test.js',
  'wealth.test.js',
  'sources.test.js',
  'ocr.test.js',
  'jobs.test.js',
  'report.test.js',
  'integration.test.js',
  'market.test.js',
]

const skipped = []
for (const file of FILES) {
  const absolute = join(here, file)
  if (!existsSync(absolute)) {
    skipped.push(file)
    continue
  }
  await import(pathToFileURL(absolute).href)
}

if (skipped.length > 0) {
  console.log(`\n[run.mjs] skipped missing test files: ${skipped.join(', ')}`)
}
