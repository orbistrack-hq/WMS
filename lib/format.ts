/**
 * The single app timezone. The operation is Pacific; using the IANA zone name
 * (not a fixed offset) means PST/PDT switch automatically with DST. Pinned on
 * every date formatter so server-rendered pages (which otherwise use the host's
 * UTC zone) and the browser agree. Mirrors the DB session zone set in migration
 * 0049 — keep the two in sync.
 */
export const APP_TIME_ZONE = "America/Los_Angeles"

const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

/** Format a numeric amount (dollars) as USD. Accepts number, string, or null. */
export function formatCurrency(
  value: number | string | null | undefined,
): string {
  const n = typeof value === "string" ? Number(value) : (value ?? 0)
  return currencyFormatter.format(Number.isFinite(n) ? n : 0)
}

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  timeZone: APP_TIME_ZONE,
})

const dateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: APP_TIME_ZONE,
})

// YYYY-MM-DD in the app timezone. en-CA yields ISO-ordered parts.
const isoDateFormatter = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  timeZone: APP_TIME_ZONE,
})

/** Format an ISO date/timestamp as e.g. "Jun 23, 2026". */
export function formatDate(value: string | null | undefined): string {
  if (!value) return "—"
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? "—" : dateFormatter.format(d)
}

/** Format an ISO timestamp as e.g. "Jun 23, 2026, 4:05 PM". */
export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—"
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? "—" : dateTimeFormatter.format(d)
}

/** Today's date as YYYY-MM-DD in the app timezone, for date input defaults. */
export function todayISODate(): string {
  return isoDateFormatter.format(new Date())
}

/** Format a gram amount, e.g. 448 -> "448g", 3.5 -> "3.5g". */
export function formatGrams(value: number | string | null | undefined): string {
  const n = typeof value === "string" ? Number(value) : (value ?? 0)
  if (!Number.isFinite(n)) return "0g"
  const v = Math.round(n * 100) / 100
  return `${Number.isInteger(v) ? v : v.toFixed(1)}g`
}
