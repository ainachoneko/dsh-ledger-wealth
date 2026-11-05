/**
 * OCR tool: scan a receipt image and return bookkeeping drafts.
 *
 * This tool never writes to the database. It returns `drafts` for the model to
 * confirm with the user, then the ledger tool (`ledger_add_entry`) persists the
 * accepted draft with `source: 'ocr'`.
 * @module dsh-ledger-wealth/tools/ocr
 */

import { dateInZone } from '../dates.js'
import { CODES, fail } from '../errors.js'
import { ocrReceiptImage, parseReceiptText } from '../ocr.js'
import { registerJsonTool } from '../toolkit.js'

/** Render one draft as a Chinese preview line. */
function renderDraft(draft, index) {
  const typeLabel = draft.type === 'income' ? '收入' : '支出'
  const amount = typeof draft.amount === 'number' ? `¥${draft.amount.toFixed(2)}` : '（金额未识别）'
  const date = draft.date ?? '（日期未识别）'
  const merchant = draft.merchant ? ` · 商户：${draft.merchant}` : ''
  const lines = [`${index + 1}) ${typeLabel} ${amount} · ${draft.category} · ${date}${merchant}`]
  for (const warning of draft.warnings ?? []) lines.push(`   提示：${warning}`)
  return lines.join('\n')
}

/** User-facing summary of one scan. */
function renderScanText({ drafts, provider, rawText }) {
  if (drafts.length === 0) {
    return `OCR（${provider}）已完成，但没有解析出可用的记账草稿。\n原始文本：\n${rawText}`
  }
  const lines = [`识别完成（提供方：${provider}），生成 ${drafts.length} 条记账草稿，尚未写入账本：`]
  drafts.forEach((draft, index) => lines.push(renderDraft(draft, index)))
  lines.push('')
  lines.push('请把上面的字段与用户核对；确认后调用 ledger_add_entry（带 confirm=true）写入，source 使用 ocr。')
  lines.push('金额或日期为「未识别」时必须先向用户询问，禁止自行猜测。')
  return lines.join('\n')
}

/**
 * Register the OCR tools on the host context.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ db?: unknown, config: Record<string, unknown>, today?: () => string }} deps
 */
export function registerOcrTools(ctx, deps) {
  const { config } = deps ?? {}
  const cfg = config ?? {}
  const todayOf = typeof deps?.today === 'function' ? deps.today : () => dateInZone(new Date(), cfg.timeZone ?? 'Asia/Shanghai')

  registerJsonTool(ctx, {
    name: 'ledger_scan_receipt',
    description:
      '识别小票/收据图片并生成记账草稿（不写库）。需要本机安装可选的 OCR 组件（rapidocr_onnxruntime 或自定义命令）；' +
      '未安装时返回 no_ocr_provider 提示，可改用文字记账。识别不到的金额/日期会置空并给出警告，绝不猜测。',
    parameters: {
      image_path: { type: 'string', required: true, description: '小票图片的绝对路径（png/jpg/webp 等，取决于 OCR 引擎）' },
    },
    async execute(args) {
      const imagePath = typeof args?.image_path === 'string' ? args.image_path.trim() : ''
      if (imagePath === '') {
        throw fail(CODES.invalid_argument, '请提供小票图片路径（image_path）。', { field: 'image_path' })
      }
      const scanned = await ocrReceiptImage(imagePath, { config: cfg })
      if (!scanned.ok) {
        return {
          ok: false,
          code: scanned.code,
          message: scanned.message,
          hint: scanned.hint,
          detail: scanned.detail,
        }
      }
      const parsed = parseReceiptText(scanned.text, { today: todayOf() })
      return {
        ok: true,
        provider: scanned.provider,
        drafts: parsed.drafts,
        raw_text: parsed.raw_text,
        text: renderScanText({ drafts: parsed.drafts, provider: scanned.provider, rawText: parsed.raw_text }),
      }
    },
  })
}
