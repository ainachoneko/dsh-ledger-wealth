/**
 * 银行理财数据源。
 *
 * 现状（2026-11-05）：没有可用的免费公开数据源（psbcwm-mcp 之类的 MCP 需要本地服务且需登录），
 * 因此这里**恒返回 `not_covered`**，绝不爬网页、绝不编造收益。
 * 降级链会据此走 stale（沿用上次值）或 unavailable。
 * @module dsh-ledger-wealth/sources/bank
 */

/** 已知覆盖的银行理财产品标识：空对象表示明确「无免费数据源」。 */
export const BANK_COVERAGE = {}

/**
 * 查询银行理财快照（当前必然不可用）。
 * @param {string} identifier 产品标识（目前仅用于日志/说明，不参与网络请求）
 * @param {{timeoutMs?: number, signal?: AbortSignal}} [options]
 * @returns {Promise<{ok:false, reason:'not_covered', detail:string}>}
 */
export async function fetchBankSnapshot(identifier, options = {}) {
  void identifier
  void options
  return {
    ok: false,
    reason: 'not_covered',
    detail: '银行理财暂无可用免费数据源（psbcwm-mcp 需本地服务）',
  }
}
