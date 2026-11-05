/**
 * Structured, model-facing failures. Domain code throws `LedgerError`; the tool
 * layer converts it to a JSON `{ code, message, ...details }` result so a
 * rejected call is a readable result instead of a turn-ending exception.
 * @module dsh-ledger-wealth/errors
 */

/** Stable error codes shared with tests and documentation. */
export const CODES = {
  invalid_config: 'invalid_config',
  need_initial_balance: 'need_initial_balance',
  already_initialized: 'already_initialized',
  invalid_amount: 'invalid_amount',
  invalid_type: 'invalid_type',
  invalid_category: 'invalid_category',
  invalid_date: 'invalid_date',
  invalid_source: 'invalid_source',
  invalid_month: 'invalid_month',
  invalid_argument: 'invalid_argument',
  confirmation_required: 'confirmation_required',
  entry_not_found: 'entry_not_found',
  product_not_found: 'product_not_found',
  duplicate_product: 'duplicate_product',
  source_unavailable: 'source_unavailable',
  no_ocr_provider: 'no_ocr_provider',
  schedule_unavailable: 'schedule_unavailable',
  storage_error: 'storage_error',
  internal_error: 'internal_error',
}

/** Domain error carrying a stable code and optional detail fields. */
export class LedgerError extends Error {
  /**
   * @param {string} code stable code from {@link CODES}
   * @param {string} message human readable, in Chinese
   * @param {Record<string, unknown>} [details] extra JSON fields for the caller
   */
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'LedgerError'
    this.code = code
    this.details = details
  }
}

/** Shorthand constructor. */
export function fail(code, message, details) {
  return new LedgerError(code, message, details)
}

/** Tool-layer adapter: LedgerError -> stable result object, anything else -> internal_error. */
export function toToolError(error, fallbackMessage = '操作失败，请稍后重试。') {
  if (error instanceof LedgerError) {
    return { ok: false, code: error.code, message: error.message, ...error.details }
  }
  const detail = error instanceof Error ? error.message : String(error)
  return { ok: false, code: CODES.internal_error, message: fallbackMessage, detail }
}
