/**
 * Money helpers. Every persisted amount is an integer number of fen (cents).
 * Yuan values are accepted only at the tool boundary and converted once.
 * @module dsh-ledger-wealth/money
 */

/** Expense / income categories fixed by the product spec. */
export const CATEGORIES = [
  '餐饮',
  '交通',
  '购物',
  '居住',
  '娱乐',
  '医疗',
  '工资',
  '理财赎回',
  '其他',
]

/** Income-oriented categories; used only for validation hints. */
export const INCOME_CATEGORIES = ['工资', '理财赎回', '其他']

/** Strict yuan -> fen conversion. Rejects non-finite, over-precise, negative or zero values. */
export function toCents(value, field = 'amount') {
  let text
  if (typeof value === 'string') {
    text = value.trim().replace(/,/g, '')
  } else if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${field} must be a finite number`)
    text = value.toFixed(2)
  } else {
    throw new TypeError(`${field} must be a number`)
  }
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(text)
  if (match === null) throw new TypeError(`${field} must be a yuan amount with at most 2 decimals: ${String(value)}`)
  const sign = match[1] === '-' ? -1 : 1
  const whole = Number(match[2])
  const frac = Number((match[3] ?? '').padEnd(2, '0'))
  const cents = sign * (whole * 100 + frac)
  if (!Number.isSafeInteger(cents)) throw new TypeError(`${field} is out of range`)
  return cents
}

/** Positive-only conversion for transaction / holding amounts. */
export function toPositiveCents(value, field = 'amount') {
  const cents = toCents(value, field)
  if (cents <= 0) throw new TypeError(`${field} must be greater than 0`)
  return cents
}

/** Signed conversion for profits (may be negative or zero). */
export function toSignedCents(value, field = 'amount') {
  return toCents(value, field)
}

/** fen -> yuan number rounded to 2 decimals. */
export function fromCents(cents) {
  return Math.round(cents) / 100
}

/** fen -> "1234.56" fixed 2-decimal string. */
export function centsToPlain(cents) {
  const n = Math.round(cents)
  const sign = n < 0 ? '-' : ''
  const abs = Math.abs(n)
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

/** fen -> "¥1,234.56" (negative: "-¥1,234.56"). */
export function formatCny(cents) {
  const n = Math.round(cents)
  const sign = n < 0 ? '-' : ''
  const abs = Math.abs(n)
  const whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const frac = String(abs % 100).padStart(2, '0')
  return `${sign}¥${whole}.${frac}`
}

/** Percentage of total, 1 decimal, "37.4%"; null when total is 0. */
export function percentOf(part, total) {
  if (!total) return null
  return `${((part / total) * 100).toFixed(1)}%`
}

/** Signed delta rendering for month-over-month comparisons. */
export function formatDeltaCny(cents) {
  const n = Math.round(cents)
  if (n === 0) return '¥0.00'
  return `${n > 0 ? '+' : '-'}${formatCny(Math.abs(n))}`
}

/** Parse an optional yuan field: undefined/null/'' -> null, otherwise positive fen. */
export function optionalCents(value, field) {
  if (value === undefined || value === null || value === '') return null
  return toPositiveCents(value, field)
}

/** Parse an optional signed yuan field: undefined/null/'' -> null. */
export function optionalSignedCents(value, field) {
  if (value === undefined || value === null || value === '') return null
  return toSignedCents(value, field)
}
