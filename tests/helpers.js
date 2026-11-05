/**
 * Shared test fixtures: in-memory databases, a fake cordis context and a tool
 * invoker. No test may touch the network or the real DSH data directory.
 * @module dsh-ledger-wealth/tests/helpers
 */

import { openDb } from '../lib/db.js'
import { resolveConfig } from '../lib/config.js'

/** Fresh in-memory database with the production schema. */
export function createMemoryDb() {
  return openDb(':memory:')
}

/** Config with the defaults, plus overrides. */
export function testConfig(overrides = {}) {
  return resolveConfig({ timeZone: 'Asia/Shanghai', ...overrides })
}

/**
 * Minimal stand-in for the cordis context.
 * - `definitions` keeps every registered tool by name, so a test can call it
 *   directly without the host runtime.
 * - `effect` records disposers so a test can assert cleanup happened.
 */
export function createTestContext({ schedule } = {}) {
  const definitions = new Map()
  const disposers = []
  const ctx = {
    tools: {
      register(definition) {
        if (definitions.has(definition.name)) throw new Error(`duplicate tool: ${definition.name}`)
        definitions.set(definition.name, definition)
        return definition
      },
      // Some host versions return a disposable from register().
      unregister(name) {
        definitions.delete(name)
      },
    },
    effect(setup) {
      const dispose = setup()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    ...(schedule === undefined ? {} : { schedule }),
  }
  return {
    ctx,
    definitions,
    disposers,
    /** Call one registered tool exactly as the runtime would. */
    async call(name, args = {}, exec = {}) {
      const definition = definitions.get(name)
      if (definition === undefined) {
        throw new Error(`tool not registered: ${name} (have: ${[...definitions.keys()].join(', ')})`)
      }
      return definition.execute(args, exec)
    },
    /** Render a tool result through its own renderer (content blocks). */
    render(name, args, value) {
      const definition = definitions.get(name)
      if (definition === undefined) throw new Error(`tool not registered: ${name}`)
      return definition.output.render(args, value)
    },
    dispose() {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose()
        } catch {
          /* ignore */
        }
      }
    },
  }
}

/** Concatenate every text block of a render result. */
export function textOf(blocks) {
  return blocks
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('\n')
}
