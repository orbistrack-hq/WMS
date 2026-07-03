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
})

const dateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
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

/** Today's date as YYYY-MM-DD, for date input defaults. */
export function todayISODate(): string {
  return new Date().toISOString().slice(0, 10)
}

/** Format a gram amount, e.g. 448 -> "448g", 3.5 -> "3.5g". */
export function formatGrams(value: number | string | null | undefined): string {
  const n = typeof value === "string" ? Number(value) : (value ?? 0)
  if (!Number.isFinite(n)) return "0g"
  const v = Math.round(n * 100) / 100
  return `${Number.isInteger(v) ? v : v.toFixed(1)}g`
}
