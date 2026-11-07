// ---------------------------------------------------------------------------
// Shake pots (migration 0117): shared vocabulary and the pure math the Shake
// screen uses. The shares themselves are computed in the database
// (shake_brand_shares) and re-checked by distribute_shake; nothing here can
// change a brand's share, it only helps the manager fill units within it.
// ---------------------------------------------------------------------------

export const QUALITIES = ["light_dep", "indoor", "exotic"] as const
export type Quality = (typeof QUALITIES)[number]

export const QUALITY_LABEL: Record<Quality, string> = {
  light_dep: "Light dep",
  indoor: "Indoor",
  exotic: "Exotic",
}

/**
 * Label for any pot in history, including the hidden one-off "premium" pot
 * (migration 0118), which is never offered on the screen.
 */
export function potLabel(pot: string): string {
  if (isQuality(pot)) return QUALITY_LABEL[pot]
  if (pot === "premium") return "Premium"
  return pot
}

export function isQuality(v: unknown): v is Quality {
  return typeof v === "string" && (QUALITIES as readonly string[]).includes(v)
}

/**
 * Grams in a pound for shake only. Shake is weighed on a true pound (454 g),
 * unlike strain stock, which stays on the 448 g house pound (lib/catalog/weight.ts,
 * intake). 1 oz is a sixteenth of that pound.
 */
export const SHAKE_LB_GRAMS = 454

/** Weighing units on the Shake screen. */
export const WEIGH_UNITS = { g: 1, oz: SHAKE_LB_GRAMS / 16, lb: SHAKE_LB_GRAMS } as const
export type WeighUnit = keyof typeof WEIGH_UNITS

export function toGrams(amount: number, unit: WeighUnit): number {
  return Math.round(amount * WEIGH_UNITS[unit] * 100) / 100
}

/** "1,362g (3.00 lb)" style: grams first, pounds as a hint from a quarter pound up. */
export function gramsWithPounds(grams: number): string {
  const g = Math.round(grams * 100) / 100
  const gs = `${g.toLocaleString("en-US", { maximumFractionDigits: 2 })}g`
  return g >= SHAKE_LB_GRAMS / 4 ? `${gs} (${(g / SHAKE_LB_GRAMS).toFixed(2)} lb)` : gs
}

export type Variant = { id: string; gramsPerUnit: number }

/**
 * Suggest units per size that use as much of `target` as possible, biggest
 * size first, then smaller sizes for what's left. Never exceeds the target.
 * Returns child_sku_id -> units (0 omitted).
 */
export function suggestFill(target: number, variants: Variant[]): Record<string, number> {
  const out: Record<string, number> = {}
  let left = Math.floor(target * 100) / 100
  const sorted = [...variants]
    .filter((v) => v.gramsPerUnit > 0)
    .sort((a, b) => b.gramsPerUnit - a.gramsPerUnit)
  for (const v of sorted) {
    const n = Math.floor((left + 1e-9) / v.gramsPerUnit)
    if (n > 0) {
      out[v.id] = n
      left = Math.round((left - n * v.gramsPerUnit) * 100) / 100
    }
  }
  return out
}

/** Grams used by a units map. */
export function gramsUsed(units: Record<string, number>, variants: Variant[]): number {
  let g = 0
  for (const v of variants) g += (units[v.id] ?? 0) * v.gramsPerUnit
  return Math.round(g * 100) / 100
}

// ---- Sales period ----------------------------------------------------------

/** Add days to a YYYY-MM-DD date (calendar math, no time zone involved). */
export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number)
  const t = new Date(Date.UTC(y, m - 1, d + days))
  return t.toISOString().slice(0, 10)
}

export type PeriodPreset = "since_last" | "7d" | "30d" | "month"

export const PERIOD_PRESET_LABEL: Record<PeriodPreset, string> = {
  since_last: "Since last split",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  month: "This month",
}

/**
 * Resolve a preset to {from, to} (inclusive Pacific days). "Since last split"
 * starts the day after the last distribution's period ended; with no earlier
 * distribution (or one ending today or later) it falls back to the last 30 days.
 */
export function presetPeriod(
  preset: PeriodPreset,
  today: string,
  lastPeriodTo: string | null,
): { from: string; to: string } {
  switch (preset) {
    case "7d":
      return { from: addDays(today, -6), to: today }
    case "month":
      return { from: `${today.slice(0, 8)}01`, to: today }
    case "since_last":
      if (lastPeriodTo && lastPeriodTo < today)
        return { from: addDays(lastPeriodTo, 1), to: today }
      return { from: addDays(today, -29), to: today }
    case "30d":
    default:
      return { from: addDays(today, -29), to: today }
  }
}
