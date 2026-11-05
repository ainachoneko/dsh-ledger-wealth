/**
 * 公开基金数据源（东方财富 / 天天基金）。
 *
 * 实测结论（2026-11-05）：
 * - 主源 `http://fund.eastmoney.com/pingzhongdata/<code>.js` 可用，返回 JS 变量文件，
 *   `fS_name` 为基金名称，`Data_netWorthTrend` 为净值走势数组（`x` 毫秒时间戳、`y` 单位净值、
 *   `equityReturn` 当日涨跌幅）。x 是北京时间零点，日期换算必须按 UTC+8，不能直接 toISOString。
 * - `https://fundgz.1234567.com.cn/js/<code>.js` 对 000001 返回的是 HTTP 200 的 HTML 404 页面，
 *   因此必须以 `jsonpgz(` 前缀校验，否则视为 not_found。它的数据是盘中估值，只能用于 estimated 降级。
 * - 备选历史净值接口 `https://api.fund.eastmoney.com/f10/lsjz`（需要 Referer）。
 *
 * 本模块不做任何缓存，也不写数据库；网络失败以 `{ ok:false, reason }` 返回，绝不抛异常。
 * fetch 可注入（`fetchImpl`）以便离线测试。
 * @module dsh-ledger-wealth/sources/fund
 */

/** 基金代码格式：6 位数字。 */
const CODE_RE = /^\d{6}$/

/** 浏览器 UA，部分公开接口会拒绝空 UA。 */
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

/** 东财历史净值接口要求 Referer。 */
const EASTMONEY_REFERER = 'http://fundf10.eastmoney.com/'

function round4(value) {
  return Math.round(value * 10000) / 10000
}

/**
 * 北京时间零点的时间戳 -> YYYY-MM-DD。
 * 东财的 x 是北京时间零点对应的毫秒时间戳（UTC 前一日 16:00），直接 toISOString 会少一天。
 */
function beijingDateOf(ms) {
  return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

/**
 * 取 `Data_netWorthTrend` 数组体中最近两个净值点。
 * 该数组是 JS 字面量（键无引号），不能直接 JSON.parse，这里用逐对象正则防御性解析。
 */
function parseNetWorthTrend(text) {
  const marker = text.indexOf('Data_netWorthTrend')
  if (marker < 0) return null
  const bracket = text.indexOf('[', marker)
  if (bracket < 0) return null
  let depth = 0
  let end = -1
  for (let i = bracket; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '[') depth += 1
    else if (ch === ']') {
      depth -= 1
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  if (end < 0) return null
  const body = text.slice(bracket + 1, end)
  const points = []
  const objectRe = /\{([^{}]*)\}/g
  let match
  while ((match = objectRe.exec(body)) !== null) {
    const inner = match[1]
    const xm = /(?:^|,)\s*x\s*:\s*(-?\d+(?:\.\d+)?)/.exec(inner)
    const ym = /(?:^|,)\s*y\s*:\s*(-?\d+(?:\.\d+)?)/.exec(inner)
    if (!xm || !ym) continue
    const x = Number(xm[1])
    const y = Number(ym[1])
    if (!Number.isFinite(x) || !Number.isFinite(y) || y <= 0) continue
    const em = /equityReturn\s*:\s*(-?\d+(?:\.\d+)?)/.exec(inner)
    points.push({ x, y, equityReturn: em ? Number(em[1]) : null })
  }
  if (points.length === 0) return null
  points.sort((a, b) => a.x - b.x)
  const last = points[points.length - 1]
  const prev = points.length > 1 ? points[points.length - 2] : null
  return { last, prev }
}

/**
 * 纯函数：解析东财 `pingzhongdata/<code>.js`。
 * @param {string} text 响应文本
 * @param {string} [code] 基金代码（用于回填）
 * @returns {{code:string, name:string|null, navDate:string, unitNav:number,
 *            prevNavDate:string|null, prevUnitNav:number|null, changePct:number|null,
 *            estNav:null, estChangePct:null, estTime:null}|null} 解析失败返回 null
 */
export function parsePingzhongData(text, code = null) {
  if (typeof text !== 'string' || text.trim() === '') return null
  const trend = parseNetWorthTrend(text)
  if (!trend) return null
  const nameMatch = /var\s+fS_name\s*=\s*"([^"]*)"/.exec(text) ?? /var\s+fS_name\s*=\s*'([^']*)'/.exec(text)
  const { last, prev } = trend
  let changePct = last.equityReturn
  if (changePct === null && prev && prev.y !== 0) {
    changePct = round4(((last.y - prev.y) / prev.y) * 100)
  }
  return {
    code: typeof code === 'string' ? code : null,
    name: nameMatch ? nameMatch[1] : null,
    navDate: beijingDateOf(last.x),
    unitNav: last.y,
    prevNavDate: prev ? beijingDateOf(prev.x) : null,
    prevUnitNav: prev ? prev.y : null,
    changePct,
    estNav: null,
    estChangePct: null,
    estTime: null,
  }
}

/**
 * 纯函数：解析天天基金 `fundgz` jsonp。
 * 必须以 `jsonpgz(` 开头；对 HTML 404 页面或其它内容返回 null。
 * @param {string} text
 * @returns {{code:string|null, name:string|null, navDate:string|null, unitNav:number,
 *            prevNavDate:null, prevUnitNav:null, changePct:number|null,
 *            estNav:number|null, estChangePct:number|null, estTime:string|null}|null}
 */
export function parseFundGz(text) {
  if (typeof text !== 'string') return null
  const trimmed = text.trim().replace(/^\uFEFF/, '')
  if (!trimmed.startsWith('jsonpgz(')) return null
  const start = trimmed.indexOf('(')
  const end = trimmed.lastIndexOf(')')
  if (start < 0 || end <= start) return null
  let payload
  try {
    payload = JSON.parse(trimmed.slice(start + 1, end))
  } catch {
    return null
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null
  const num = (value) => {
    if (value === undefined || value === null || value === '') return null
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  const unitNav = num(payload.dwjz)
  if (unitNav === null) return null
  return {
    code: typeof payload.fundcode === 'string' ? payload.fundcode : null,
    name: typeof payload.name === 'string' ? payload.name : null,
    navDate: typeof payload.jzrq === 'string' ? payload.jzrq : null,
    unitNav,
    prevNavDate: null,
    prevUnitNav: null,
    changePct: num(payload.gszzl),
    estNav: num(payload.gsz),
    estChangePct: num(payload.gszzl),
    estTime: typeof payload.gztime === 'string' ? payload.gztime : null,
  }
}

/**
 * 纯函数：解析东财历史净值 JSON（备选源）。
 * `Data.LSJZList` 每项含 `FSRQ`(日期)、`DWJZ`(单位净值)、`JZZZL`(日涨跌幅%)。
 */
function parseLsjzJson(text, code) {
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    return null
  }
  const list = payload?.Data?.LSJZList
  if (!Array.isArray(list) || list.length === 0) return null
  const points = []
  for (const row of list) {
    const date = typeof row?.FSRQ === 'string' ? row.FSRQ : null
    if (date === null || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    const nav = Number(row?.DWJZ)
    if (!Number.isFinite(nav) || nav <= 0) continue
    const pct = Number(row?.JZZZL)
    points.push({ date, nav, pct: Number.isFinite(pct) ? pct : null })
  }
  if (points.length === 0) return null
  points.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  const last = points[points.length - 1]
  const prev = points.length > 1 ? points[points.length - 2] : null
  const changePct =
    last.pct !== null
      ? last.pct
      : prev && prev.nav !== 0
        ? round4(((last.nav - prev.nav) / prev.nav) * 100)
        : null
  return {
    code,
    name: null,
    navDate: last.date,
    unitNav: last.nav,
    prevNavDate: prev ? prev.date : null,
    prevUnitNav: prev ? prev.nav : null,
    changePct,
    estNav: null,
    estChangePct: null,
    estTime: null,
  }
}

/** 组合超时信号与调用方信号。 */
function makeSignal(timeoutMs, signal) {
  const ms = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Math.round(Number(timeoutMs)) : 8000
  const timeoutSignal = AbortSignal.timeout(ms)
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
}

/** 一次文本请求；网络/HTTP 失败映射为稳定的 reason。 */
async function requestText(fetchImpl, url, { signal, headers = {} } = {}) {
  let response
  try {
    response = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT, ...headers }, signal })
  } catch (error) {
    const name = error?.name
    return {
      ok: false,
      reason: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network',
      detail: error?.message ?? String(error),
    }
  }
  if (!response || typeof response.text !== 'function') {
    return { ok: false, reason: 'network', detail: '响应对象无效' }
  }
  if (response.status === 404) return { ok: false, reason: 'http_404', detail: `HTTP 404：${url}` }
  if (response.ok === false) {
    return { ok: false, reason: 'network', detail: `HTTP ${response.status ?? 'unknown'}：${url}` }
  }
  try {
    return { ok: true, text: await response.text() }
  } catch (error) {
    return { ok: false, reason: 'network', detail: error?.message ?? String(error) }
  }
}

/**
 * 拉取一只基金的最新快照。按主源 -> 历史净值备选 -> 盘中估值的顺序降级；
 * 任何来源失败都不会抛异常，全部失败时返回首个失败的 reason。
 * @param {string} identifier 6 位基金代码
 * @param {{timeoutMs?: number, fetchImpl?: typeof fetch, signal?: AbortSignal}} [options]
 * @returns {Promise<{ok:true, data:object} | {ok:false, reason:string, detail:string}>}
 */
export async function fetchFundSnapshot(identifier, { timeoutMs = 8000, fetchImpl = fetch, signal } = {}) {
  const code = typeof identifier === 'string' ? identifier.trim() : String(identifier ?? '').trim()
  if (!CODE_RE.test(code)) {
    return {
      ok: false,
      reason: 'invalid_identifier',
      detail: `基金代码必须是 6 位数字：${identifier === undefined ? 'undefined' : String(identifier)}`,
    }
  }
  if (typeof fetchImpl !== 'function') {
    return { ok: false, reason: 'network', detail: '当前运行环境没有可用的 fetch' }
  }
  const requestSignal = makeSignal(timeoutMs, signal)
  const failures = []
  const attempts = []

  // 1) 主源：东财 pingzhongdata（含最近两个交易日真实净值）。
  const primary = await requestText(fetchImpl, `http://fund.eastmoney.com/pingzhongdata/${code}.js`, {
    signal: requestSignal,
  })
  if (primary.ok) {
    const data = parsePingzhongData(primary.text, code)
    if (data) return { ok: true, data }
    failures.push({ source: 'pingzhongdata', reason: 'parse_error', detail: '未解析出 Data_netWorthTrend' })
  } else {
    failures.push({ source: 'pingzhongdata', reason: primary.reason, detail: primary.detail })
  }
  attempts.push(failures[failures.length - 1])

  // 2) 备选：东财历史净值 JSON（同样能提供两日真实净值）。
  const backup = await requestText(
    fetchImpl,
    `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}&pageIndex=1&pageSize=10`,
    { signal: requestSignal, headers: { Referer: EASTMONEY_REFERER } },
  )
  if (backup.ok) {
    const data = parseLsjzJson(backup.text, code)
    if (data) return { ok: true, data }
    failures.push({ source: 'lsjz', reason: 'parse_error', detail: '未解析出 LSJZList' })
  } else {
    failures.push({ source: 'lsjz', reason: backup.reason, detail: backup.detail })
  }
  attempts.push(failures[failures.length - 1])

  // 3) 盘中估值：只有涨跌幅，没有真实净值差，仅能用于 estimated。
  const estimate = await requestText(fetchImpl, `https://fundgz.1234567.com.cn/js/${code}.js?rt=1`, {
    signal: requestSignal,
  })
  if (estimate.ok) {
    const data = parseFundGz(estimate.text)
    if (data) return { ok: true, data }
    failures.push({ source: 'fundgz', reason: 'not_found', detail: '响应不是 jsonpgz(...)' })
  } else {
    failures.push({ source: 'fundgz', reason: estimate.reason, detail: estimate.detail })
  }
  attempts.push(failures[failures.length - 1])

  const first = failures[0]
  return {
    ok: false,
    reason: first.reason,
    detail: `${first.detail ?? first.reason}（尝试：${attempts.map((a) => `${a.source}:${a.reason}`).join(' -> ')}）`,
  }
}
