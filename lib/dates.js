/**
 * Calendar helpers. All persisted dates are calendar dates (YYYY-MM-DD) in the
 * configured IANA zone; month keys are YYYY-MM. Date arithmetic is done in UTC
 * on the date-only triple so DST never shifts a stored date.
 * @module dsh-ledger-wealth/dates
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const MONTH_RE = /^\d{4}-\d{2}$/

/** Today's calendar date (YYYY-MM-DD) in `timeZone`. */
export function dateInZone(now = new Date(), timeZone = 'Asia/Shanghai') {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const parts = fmt.formatToParts(now)
  const get = (type) => parts.find((p) => p.type === type)?.value
  return `${get('year')}-${get('month')}-${get('day')}`
}

/** Current wall clock as ISO string with the zone offset, for audit columns. */
export function nowIso(now = new Date()) {
  return now.toISOString()
}

/** Validate a YYYY-MM-DD string and that it is a real calendar date. */
export function assertDate(value, field = 'date') {
  if (typeof value !== 'string' || !DATE_RE.test(value)) {
    throw new TypeError(`${field} must be YYYY-MM-DD`)
  }
  const [y, m, d] = value.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    throw new TypeError(`${field} is not a real calendar date: ${value}`)
  }
  return value
}

/** 'YYYY-MM' for a date string. */
export function monthKeyOf(dateStr) {
  assertDate(dateStr)
  return dateStr.slice(0, 7)
}

/** Validate a YYYY-MM month key. */
export function assertMonth(month) {
  if (typeof month !== 'string' || !MONTH_RE.test(month)) throw new TypeError('month must be YYYY-MM')
  const m = Number(month.slice(5, 7))
  if (m < 1 || m > 12) throw new TypeError(`month out of range: ${month}`)
  return month
}

/** Number of days in a YYYY-MM month. */
export function daysInMonth(month) {
  assertMonth(month)
  const y = Number(month.slice(0, 4))
  const m = Number(month.slice(5, 7))
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

/** First and last calendar date of a month. */
export function monthRange(month) {
  return { start: `${month}-01`, end: `${month}-${String(daysInMonth(month)).padStart(2, '0')}` }
}

/** True when `dateStr` is the last calendar day of its month. */
export function isMonthEnd(dateStr) {
  return dateStr === monthRange(monthKeyOf(dateStr)).end
}

/** Previous month key ('2026-01' -> '2025-12'). */
export function previousMonth(month) {
  assertMonth(month)
  const y = Number(month.slice(0, 4))
  const m = Number(month.slice(5, 7))
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`
}

/** Add days to a date string (negative allowed). */
export function addDays(dateStr, days) {
  assertDate(dateStr)
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d + days))
  return dt.toISOString().slice(0, 10)
}

/** Whole days from `a` to `b` (b - a). */
export function daysBetween(a, b) {
  assertDate(a)
  assertDate(b)
  const [ay, am, ad] = a.split('-').map(Number)
  const [by, bm, bd] = b.split('-').map(Number)
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000)
}

/** Current month key in a zone. */
export function currentMonth(now = new Date(), timeZone = 'Asia/Shanghai') {
  return monthKeyOf(dateInZone(now, timeZone))
}
