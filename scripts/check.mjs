/**
 * Offline smoke check: parse and import every runtime module.
 *
 * The sandbox forbids spawning `node --check`, so this script validates the same
 * thing by importing each module (syntax + import graph + top-level execution).
 * It never calls `apply()`, so no database or host service is touched.
 *
 * Usage: node scripts/check.mjs
 */

import { readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

function walk(directory) {
  const files = []
  for (const entry of readdirSync(directory)) {
    const absolute = join(directory, entry)
    if (statSync(absolute).isDirectory()) files.push(...walk(absolute))
    else if (entry.endsWith('.js')) files.push(absolute)
  }
  return files
}

const files = [...walk(join(root, 'lib'))].sort()
let failed = 0

for (const file of files) {
  const label = relative(root, file).replaceAll('\\', '/')
  try {
    await import(pathToFileURL(file).href)
    console.log(`  ok   ${label}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${label}\n       ${error?.message ?? error}`)
  }
}

console.log(`\n[check.mjs] ${files.length - failed}/${files.length} modules import cleanly`)
if (failed > 0) process.exitCode = 1
