/**
 * Thin wrapper over `@deepseek-ai/dsh-tools` used by every tool module.
 *
 * Guarantees shared by all plugin tools:
 * - domain failures never throw out of `execute` (they become `{ ok:false, code, message }`)
 * - every result carries an `ok` boolean so a rejected call is still a readable result
 * - the model receives the canonical JSON plus, when present, a `text` field that is
 *   already written for the end user (Chinese, amounts formatted with two decimals)
 * @module dsh-ledger-wealth/toolkit
 */

import { toToolError } from './errors.js'

/**
 * `defineTool` 由宿主注入：DSH 通过自己的加载器提供 `@deepseek-ai/dsh-tools`，
 * 装进 profile 的插件包里它通常不在 node_modules 里。因此这里用动态 import 探测，
 * 探测不到就退到本文件内的等价实现（同样是「属性表 -> JSON Schema + 必填校验」），
 * 保证插件在任何宿主上都能装载，而不是因为一个 import 直接起不来。
 */
let defineTool = localDefineTool
try {
  const host = await import('@deepseek-ai/dsh-tools')
  if (typeof host.defineTool === 'function') defineTool = host.defineTool
} catch {
  /* 宿主未注入：使用本地实现 */
}

/** 把工具参数表（属性表 DSL）编译成 JSON Schema。 */
export function compileParameters(parameters = {}) {
  const properties = {}
  const required = []
  for (const [key, spec] of Object.entries(parameters ?? {})) {
    const { required: isRequired, ...rest } = spec ?? {}
    properties[key] = compileValue(rest)
    if (isRequired === true) required.push(key)
  }
  return { type: 'object', properties, ...(required.length > 0 ? { required } : {}) }
}

/** 单个值节点：把可选的 items / properties 递归编译，其余原样保留。 */
function compileValue(spec) {
  const node = { ...spec }
  delete node.required
  if (node.type === 'array' && node.items !== undefined) node.items = compileValue(node.items)
  if (node.type === 'object' && node.properties !== undefined) {
    const nested = compileParameters(node.properties)
    node.properties = nested.properties
    if (nested.required !== undefined) node.required = nested.required
  }
  if (node.oneOf !== undefined) node.oneOf = node.oneOf.map((branch) => compileValue(branch))
  return node
}

/**
 * 宿主没有提供 dsh-tools 时的等价实现：编译参数表，执行前校验必填项。
 * 校验刻意保持宽松（只查必填与类型），领域层的校验才是唯一权威。
 */
export function localDefineTool(options) {
  const parameters = compileParameters(options.parameters ?? {})
  return {
    name: options.name,
    description: options.description,
    parameters,
    output: { schema: options.output.schema, render: options.output.render },
    async execute(args, exec) {
      const missing = (parameters.required ?? []).filter(
        (key) => args?.[key] === undefined || args?.[key] === null,
      )
      if (missing.length > 0) {
        throw new Error(`invalid arguments: ${missing.map((key) => `parameters.${key} is required`).join('; ')}`)
      }
      return options.execute(args ?? {}, exec ?? {})
    },
  }
}

/**
 * Canonical output schema subset accepted by dsh-tools.
 *
 * `output.schema` is compiled by the *value schema DSL*, which has no `required`
 * keyword (only the implicit parameter map supports per-property requiredness),
 * and requires an explicit boolean `additionalProperties` on object nodes.
 */
export const TOOL_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean', description: '是否成功' },
    status: { type: 'string', description: '状态，如 needs_confirmation / recorded / skipped' },
    text: { type: 'string', description: '面向用户的中文摘要（已格式化金额）' },
    code: { type: 'string', description: '失败时的稳定错误码' },
    message: { type: 'string', description: '失败时的中文说明' },
  },
}

/**
 * Render one canonical value into content blocks:
 * block 1 = JSON (machine friendly), block 2 = the `text` summary when present.
 * The duplicated `text` field is stripped from the JSON block to keep it compact.
 */
export function renderValue(value) {
  if (value === null || typeof value !== 'object') return [{ type: 'text', text: String(value) }]
  const { text, ...rest } = value
  const blocks = [{ type: 'text', text: JSON.stringify(rest) }]
  if (typeof text === 'string' && text.trim() !== '') blocks.push({ type: 'text', text })
  return blocks
}

/**
 * Register one JSON-returning tool.
 * @param {import('@deepseek-ai/cordis').Context} ctx host context that owns `ctx.tools`
 * @param {{
 *   name: string,
 *   description: string,
 *   parameters?: Record<string, { type: string, required?: boolean, description?: string, enum?: string[] }>,
 *   outputSchema?: Record<string, unknown>,
 *   execute: (args: Record<string, unknown>, exec: Record<string, unknown>) => unknown,
 * }} spec
 */
export function registerJsonTool(ctx, { name, description, parameters = {}, outputSchema = TOOL_RESULT_SCHEMA, execute }) {
  const definition = defineTool({
    name,
    description,
    parameters,
    output: {
      schema: outputSchema,
      render: (_args, value) => renderValue(value),
    },
    async execute(args, exec) {
      try {
        return await execute(args ?? {}, exec ?? {})
      } catch (error) {
        return toToolError(error)
      }
    },
  })
  ctx.tools.register(definition)
  return definition
}

/** Build the standard success envelope. */
export function okBody(fields = {}) {
  return { ok: true, ...fields }
}

/** Best-effort session id from a tool execution context. */
export function sessionIdOf(exec) {
  return exec?.agent?.session?.id ?? exec?.session?.id ?? null
}
