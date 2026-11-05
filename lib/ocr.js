/**
 * Optional receipt OCR.
 *
 * The plugin does not depend on any OCR package: recognition is delegated to
 * either an external CLI (`config.ocrCommand`, recognized text on stdout) or a
 * Python venv that has `rapidocr_onnxruntime` installed
 * (`config.ocrVenvPython`, created by `scripts/setup-ocr.ps1`). When neither is
 * configured the module returns a structured `no_ocr_provider` failure instead
 * of throwing, and the user is pointed at plain-text bookkeeping.
 *
 * `parseReceiptText` is a pure function: it never guesses an amount or a date.
 * Unreadable fields stay `null` and are reported in `warnings`.
 * @module dsh-ledger-wealth/ocr
 */

import { spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import { CATEGORIES, INCOME_CATEGORIES } from './money.js'
import { assertDate } from './dates.js'

/** Python one-liner used to prove the venv really has rapidocr_onnxruntime. */
const RAPIDOCR_IMPORT_SCRIPT = "import rapidocr_onnxruntime as r; print('ocr-import-ok')"

/** Python script that runs RapidOCR over one image and prints text lines. */
const RAPIDOCR_RUN_SCRIPT = [
  'import sys',
  'from rapidocr_onnxruntime import RapidOCR',
  'engine = RapidOCR()',
  'result = engine(sys.argv[1])',
  'lines = []',
  'if result:',
  '    data = result[0] if isinstance(result, tuple) else result',
  '    for item in (data or []):',
  '        if item and len(item) >= 2:',
  '            lines.append(str(item[1]))',
  'sys.stdout.write("\\n".join(lines))',
].join('\n')

/** Cap on captured stdout, protects this process from a runaway CLI. */
const MAX_STDOUT_BYTES = 1_000_000

/** Hint shown when no OCR provider is available. */
export const OCR_INSTALL_HINT =
  '图片识别是可选项：可运行 packages/dsh-ledger-wealth/scripts/setup-ocr.ps1 安装 ' +
  'rapidocr_onnxruntime，并把脚本末尾打印的 ocrVenvPython 写入插件配置；' +
  '也可以把任意「把识别文本打印到 stdout」的命令行工具配到 ocrCommand。' +
  '不安装也能记账，直接用文字输入（ledger_add_entry）即可。'

function pythonEnv() {
  return { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
}

/** Quote a path for the user-supplied command line (shell mode). */
function quoteForShell(value) {
  if (process.platform === 'win32') return `"${value.replace(/"/g, '""')}"`
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * Run one child process with a hard timeout and capture stdout.
 * Never throws and never rejects: every failure becomes `{ ok:false, code, detail }`.
 * @param {string} file executable
 * @param {string[]} args argv
 * @param {{ timeoutMs?: number, signal?: AbortSignal, env?: NodeJS.ProcessEnv, shell?: boolean }} [options]
 * @returns {Promise<{ ok: true, stdout: string, stderr: string } | { ok: false, code: string, detail: string }>}
 */
export function runProcess(file, args, options = {}) {
  const { timeoutMs = 30_000, signal, env = process.env, shell = false } = options
  return new Promise((resolvePromise) => {
    let child
    try {
      child = spawn(file, args, { shell, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env })
    } catch (error) {
      resolvePromise({ ok: false, code: 'spawn_failed', detail: error instanceof Error ? error.message : String(error) })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    let timer = null

    const cleanup = () => {
      if (timer !== null) clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
    }
    const finish = (value) => {
      if (settled) return
      settled = true
      cleanup()
      try {
        child.kill()
      } catch {
        /* the process is already gone */
      }
      resolvePromise(value)
    }
    const onAbort = () => finish({ ok: false, code: 'aborted', detail: '已取消识别。' })

    if (signal) {
      if (signal.aborted) {
        finish({ ok: false, code: 'aborted', detail: '已取消识别。' })
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
    timer = setTimeout(() => {
      finish({ ok: false, code: 'timeout', detail: `OCR 子进程超时（${timeoutMs} 毫秒）。` })
    }, timeoutMs)

    child.stdout?.on('data', (chunk) => {
      if (stdout.length > MAX_STDOUT_BYTES) {
        finish({ ok: false, code: 'output_too_large', detail: 'OCR 输出过大，已中止。' })
        return
      }
      stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < 20_000) stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      finish({ ok: false, code: 'spawn_failed', detail: error.message })
    })
    child.on('close', (code) => {
      if (settled) return
      if (code === 0) {
        finish({ ok: true, stdout, stderr })
        return
      }
      const detail = stderr.trim() !== '' ? stderr.trim().slice(0, 800) : `子进程退出码 ${code}`
      finish({ ok: false, code: 'exit_nonzero', detail })
    })
  })
}

/**
 * Detect which OCR backend this machine can use.
 * `command` is trusted when configured; `rapidocr` is probed with a real import.
 * @param {Record<string, unknown>} [config] resolved plugin config
 * @returns {Promise<{ provider: 'command'|'rapidocr'|null, detail: string }>}
 */
export async function detectOcrProvider(config = {}) {
  const mode = typeof config.ocrProvider === 'string' ? config.ocrProvider : 'auto'
  const command = typeof config.ocrCommand === 'string' ? config.ocrCommand.trim() : ''
  const venvPython = typeof config.ocrVenvPython === 'string' ? config.ocrVenvPython.trim() : ''

  if (mode === 'none') {
    return { provider: null, detail: 'ocrProvider 配置为 none，图片识别已关闭（仍可用文字记账）。' }
  }
  if (mode === 'command') {
    if (command === '') return { provider: null, detail: 'ocrProvider 为 command，但 ocrCommand 为空。' }
    return { provider: 'command', detail: `外部 OCR 命令：${command}` }
  }
  if (mode === 'rapidocr') {
    return detectRapidOcr(venvPython)
  }
  // auto: prefer an explicit CLI, then the managed venv.
  if (command !== '') return { provider: 'command', detail: `外部 OCR 命令：${command}` }
  if (venvPython === '') {
    return { provider: null, detail: '未配置 ocrCommand，也未配置 ocrVenvPython（可选组件未安装）。' }
  }
  return detectRapidOcr(venvPython)
}

async function detectRapidOcr(venvPython) {
  if (venvPython === '') {
    return { provider: null, detail: '未配置 ocrVenvPython（未安装 rapidocr_onnxruntime）。' }
  }
  let isFile = false
  try {
    isFile = statSync(venvPython).isFile()
  } catch {
    isFile = false
  }
  if (!isFile) {
    return { provider: null, detail: `ocrVenvPython 指向的文件不存在：${venvPython}` }
  }
  const check = await runProcess(venvPython, ['-c', RAPIDOCR_IMPORT_SCRIPT], {
    timeoutMs: 20_000,
    env: pythonEnv(),
  })
  if (check.ok && check.stdout.includes('ocr-import-ok')) {
    return { provider: 'rapidocr', detail: `rapidocr_onnxruntime 可用（${venvPython}）` }
  }
  const reason = check.ok ? '导入成功但输出异常' : `${check.code}：${check.detail}`
  return { provider: null, detail: `无法在 ${venvPython} 中导入 rapidocr_onnxruntime（${reason}）` }
}

function notFoundResult(imagePath) {
  return {
    ok: false,
    code: 'not_found',
    message: `找不到小票图片：${imagePath}`,
    hint: '请确认路径正确、文件存在，并尽量使用绝对路径。',
  }
}

/**
 * OCR one receipt image.
 * @param {string} imagePath absolute path to the image
 * @param {{ config?: Record<string, unknown>, timeoutMs?: number, signal?: AbortSignal }} [options]
 * @returns {Promise<{ ok: true, text: string, provider: string } |
 *   { ok: false, code: 'no_ocr_provider'|'not_found'|'ocr_failed', message: string, hint?: string, detail?: string }>}
 */
export async function ocrReceiptImage(imagePath, options = {}) {
  const { config = {}, timeoutMs, signal } = options
  const path = typeof imagePath === 'string' ? imagePath.trim() : ''
  if (path === '') {
    return {
      ok: false,
      code: 'not_found',
      message: '未提供小票图片路径。',
      hint: '请传入图片的绝对路径，例如 ledger_scan_receipt(image_path="C:/receipts/a.jpg")。',
    }
  }
  let isFile = false
  try {
    isFile = statSync(path).isFile()
  } catch {
    isFile = false
  }
  if (!isFile) return notFoundResult(path)

  let detected
  try {
    detected = await detectOcrProvider(config)
  } catch (error) {
    detected = { provider: null, detail: error instanceof Error ? error.message : String(error) }
  }
  if (!detected.provider) {
    return {
      ok: false,
      code: 'no_ocr_provider',
      message: '本机没有可用的 OCR 提供方，暂时无法识别小票图片。',
      hint: OCR_INSTALL_HINT,
      detail: detected.detail,
    }
  }

  const configured = Number(config.ocrTimeoutMs)
  const timeout =
    Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
      ? Number(timeoutMs)
      : Number.isFinite(configured) && configured > 0
        ? configured
        : 30_000

  try {
    const run =
      detected.provider === 'command'
        ? await runProcess(shellCommandLine(String(config.ocrCommand ?? ''), path), [], {
            timeoutMs: timeout,
            signal,
            shell: true,
          })
        : await runProcess(String(config.ocrVenvPython ?? ''), ['-c', RAPIDOCR_RUN_SCRIPT, path], {
            timeoutMs: timeout,
            signal,
            env: pythonEnv(),
          })
    if (!run.ok) {
      return {
        ok: false,
        code: 'ocr_failed',
        message: 'OCR 识别失败，未能从小票图片中取出文字。',
        hint: '可换一张更清晰、方向正确的图片重试；也可以改用文字记账。',
        detail: run.detail,
      }
    }
    const text = run.stdout.replace(/\r\n?/g, '\n').trim()
    if (text === '') {
      return {
        ok: false,
        code: 'ocr_failed',
        message: 'OCR 没有识别到任何文字，可能图片过于模糊或方向不对。',
        hint: '请换一张清晰的小票照片重试，或直接使用文字记账。',
      }
    }
    return { ok: true, text, provider: detected.provider }
  } catch (error) {
    return {
      ok: false,
      code: 'ocr_failed',
      message: 'OCR 识别过程出现异常。',
      hint: '请稍后重试，或改用文字记账。',
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

/** Build the command line for the external CLI, substituting `{image}` when present. */
function shellCommandLine(command, imagePath) {
  const quoted = quoteForShell(imagePath)
  if (command.includes('{image}')) return command.split('{image}').join(quoted)
  return `${command} ${quoted}`
}

/* ────────────────────────── pure receipt parsing ────────────────────────── */

/** Keywords that mark a "grand total" line, best first. 小计 is a subtotal and is excluded. */
const TOTAL_KEYWORDS = [
  { re: /实付|实收/, rank: 0 },
  { re: /合\s*计|总\s*计|应\s*付|总金额|金额合计/, rank: 1 },
]

/** Lines that carry identifiers, never money to book. */
const SKIP_LINE_RE =
  /单号|订单号|流水号|卡号|账号|电话|手机|会员号|积分|收银员|工号|发票代码|发票号码|税号|营业员/i

/** Date/time fragments inside a line (used only to skip fallback amount lines). */
const DATE_LIKE_RE =
  /(\d{4}\s*[-/.年]\s*\d{1,2})|(\d{1,2}\s*月\s*\d{1,2}\s*日)|(\d{1,2}\s*:\s*\d{2})/

/** Anything that looks like a money number in a line. */
const NUMBER_RE = /-?\d[\d,]*(?:\.\d{1,2})?/g

/** Category keyword table, first match wins. */
const CATEGORY_KEYWORDS = [
  ['工资', /工资|薪资|薪酬|月薪|奖金|劳务费/],
  ['理财赎回', /赎回|基金|理财|分红/],
  ['医疗', /医院|药店|药房|诊所|门诊|挂号|医保|体检|牙科/],
  ['居住', /房租|租金|物业|水费|电费|燃气|水电|宽带|供暖|家政|维修/],
  ['交通', /地铁|公交|打车|滴滴|出租车|高铁|火车|机票|航班|停车|加油|油费|ETC|交通|单车/],
  ['餐饮', /餐饮|餐厅|饭店|快餐|小吃|咖啡|奶茶|外卖|美团|饿了么|肯德基|麦当劳|星巴克|火锅|食堂|早餐|午餐|晚餐|烧烤|酒吧/],
  ['娱乐', /电影|影院|游戏|KTV|娱乐|演出|演唱会|健身|景点|门票|剧本杀/],
  ['购物', /超市|商场|便利店|淘宝|京东|拼多多|天猫|购物|服饰|数码|家电|百货|生鲜|水果/],
]

/** Keywords that flip a receipt from expense to income. */
const INCOME_RE = /退款|退货|退费|收入|到账|收款|入账|报销/

/** Receipt header words that are never a merchant name. */
const HEADER_SKIP_RE =
  /小票|发票|收据|清单|欢迎|谢谢|惠顾|地址|日期|时间|流水|单号|收银|支付|备注|合计|金额|NO\.?/i

/** Normalize full-width characters so the regexes stay simple. */
function normalizeText(text) {
  return String(text ?? '')
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[\uFFE5\u00A5]/g, '¥')
    .replace(/\u3000/g, ' ')
    .replace(/\r\n?/g, '\n')
}

/** True when `value` is a real YYYY-MM-DD calendar date. */
function isRealDate(value) {
  try {
    assertDate(value)
    return true
  } catch {
    return false
  }
}

/** Extract money-like numbers from one line, ignoring counts and plain integers. */
function amountCandidates(line) {
  const out = []
  for (const match of line.matchAll(NUMBER_RE)) {
    const raw = match[0]
    const index = match.index ?? 0
    const before = line.slice(Math.max(0, index - 2), index)
    const after = line.slice(index + raw.length, index + raw.length + 2)
    const hasCurrency = /[¥$]/.test(before)
    const hasYuan = /元/.test(after)
    const hasDecimal = /\.\d{1,2}$/.test(raw)
    if (!hasCurrency && !hasYuan && !hasDecimal) continue
    const value = Number(raw.replace(/,/g, ''))
    if (!Number.isFinite(value) || value <= 0) continue
    out.push(Math.round(value * 100) / 100)
  }
  return out
}

/** Pick the explicit date on the receipt, otherwise null. */
function extractDate(text, today) {
  const full = /(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?/.exec(text)
  if (full !== null) {
    const candidate = `${full[1]}-${full[2].padStart(2, '0')}-${full[3].padStart(2, '0')}`
    if (isRealDate(candidate)) return candidate
  }
  const labeled = /(?:日期|开票日期|交易日期)\D{0,4}(\d{4})(\d{2})(\d{2})/.exec(text)
  if (labeled !== null) {
    const candidate = `${labeled[1]}-${labeled[2]}-${labeled[3]}`
    if (isRealDate(candidate)) return candidate
  }
  const monthDay = /(\d{1,2})\s*月\s*(\d{1,2})\s*日/.exec(text)
  if (monthDay !== null && typeof today === 'string' && today !== '') {
    const candidate = `${today.slice(0, 4)}-${monthDay[1].padStart(2, '0')}-${monthDay[2].padStart(2, '0')}`
    if (isRealDate(candidate)) return candidate
  }
  return null
}

/** Merchant from an explicit label, else the receipt header (flagged as inferred). */
function extractMerchant(lines) {
  for (const line of lines) {
    const labeled = /(?:商户|商家|店名|店铺|门店|收款方)\s*[：:]?\s*(.{2,40})/.exec(line)
    if (labeled !== null) {
      const merchant = labeled[1].trim().replace(/\s{2,}/g, ' ')
      if (merchant !== '') return { merchant, inferred: false }
    }
  }
  for (const line of lines.slice(0, 3)) {
    const text = line.trim()
    if (text.length < 2 || text.length > 40) continue
    if (/\d/.test(text)) continue
    if (HEADER_SKIP_RE.test(text)) continue
    return { merchant: text, inferred: true }
  }
  return { merchant: null, inferred: false }
}

/** Keyword category mapping into the nine fixed categories. */
function detectCategory(text) {
  for (const [category, re] of CATEGORY_KEYWORDS) {
    if (re.test(text)) return category
  }
  return '其他'
}

/**
 * Parse raw OCR text into one receipt draft.
 * Only fields that are visibly present are filled; everything else is `null`
 * plus a warning. The total line wins over item lines, and no amount is inferred.
 * @param {string} text OCR text
 * @param {{ today?: string }} [options] today is only used to complete an explicit "M月D日"
 * @returns {{ drafts: Array<Record<string, unknown>>, raw_text: string }}
 */
export function parseReceiptText(text, options = {}) {
  const rawText = String(text ?? '')
  const normalized = normalizeText(rawText).trim()
  if (normalized === '') return { drafts: [], raw_text: '' }

  let today = typeof options.today === 'string' ? options.today.trim() : ''
  if (today !== '' && !isRealDate(today)) today = ''

  const lines = normalized
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
  const body = lines.join('\n')
  const warnings = []

  // 1. amount: explicit total line first, else the largest money-looking value.
  let amount = null
  let amountSource = 'none'
  let bestRank = Number.POSITIVE_INFINITY
  for (const line of lines) {
    if (SKIP_LINE_RE.test(line)) continue
    for (const keyword of TOTAL_KEYWORDS) {
      if (!keyword.re.test(line)) continue
      const candidates = amountCandidates(line)
      if (candidates.length === 0) continue
      if (keyword.rank < bestRank) {
        bestRank = keyword.rank
        amount = candidates[candidates.length - 1]
        amountSource = 'total'
      }
      break
    }
  }
  if (amount === null) {
    let max = null
    for (const line of lines) {
      if (SKIP_LINE_RE.test(line) || DATE_LIKE_RE.test(line)) continue
      for (const value of amountCandidates(line)) {
        if (max === null || value > max) max = value
      }
    }
    if (max !== null) {
      amount = max
      amountSource = 'fallback'
    }
  }
  if (amount === null) {
    warnings.push('未能识别金额，请手动补充后再记账。')
  } else if (amountSource === 'fallback') {
    warnings.push('未找到「合计/实付/总计」字样，金额取自票面最大金额，请核对。')
  }

  // 2. date: only an explicit date; "M月D日" needs `today` to complete the year.
  const date = extractDate(body, today)
  if (date === null) warnings.push('未能识别日期，请手动补充（或按今天记账）。')

  // 3. type: expense unless refund/income wording is visible.
  const type = INCOME_RE.test(body) ? 'income' : 'expense'
  if (type === 'income') warnings.push('票面出现「退款/收入/到账」等字样，已标记为收入，请确认。')

  // 4. category: keyword mapping, narrowed to income categories for income.
  let category = detectCategory(body)
  if (type === 'income' && !INCOME_CATEGORIES.includes(category)) category = '其他'
  if (!CATEGORIES.includes(category)) category = '其他'

  // 5. merchant: explicit label, else header guess.
  const { merchant, inferred } = extractMerchant(lines)
  if (merchant !== null && inferred) warnings.push('商户名由小票抬头推断，请核对。')

  const draft = {
    type,
    amount,
    category,
    merchant,
    date,
    note: 'OCR 小票识别（仅草稿，确认后才写入账本）',
    source: 'ocr',
    warnings,
  }
  return { drafts: [draft], raw_text: rawText }
}
