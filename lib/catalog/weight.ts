// ---------------------------------------------------------------------------
// Weight parsing for cannabis SKUs. Precision-first: only a clearly-delimited,
// known weight token matches, so an unrecognized variant is left alone rather
// than mis-grouped. Convention (matches the to_grams DB helper): 1 oz = 28 g,
// 1 lb = 448 g; eighth/quarter/half = 3.5/7/14 g.
//
// Used at store-import time to turn a variant title / attribute into a
// grams-per-unit weight so it attaches to a strain parent as a weight variant
// (see upsert_store_weight_variant), instead of flattening into its own parent.
// ---------------------------------------------------------------------------

type Rule = { re: RegExp; grams: number }

// Order matters — most specific first. Each token must be bounded by a
// non-alphanumeric on each side so "28g" never matches inside "280g" and "oz"
// never matches inside a word.
const RULES: Rule[] = [
  { re: /(?:^|[^a-z0-9])(?:1\/2\s*lb|half\s*pound|hp)(?![a-z0-9])/i, grams: 224 },
  { re: /(?:^|[^a-z0-9])(?:1\/4\s*lb|quarter\s*pound|qp)(?![a-z0-9])/i, grams: 112 },
  { re: /(?:^|[^a-z0-9])(?:1\s*lb|lb|pound)(?![a-z0-9])/i, grams: 448 },
  { re: /(?:^|[^a-z0-9.])28\s*g(?![a-z0-9])/i, grams: 28 },
  { re: /(?:^|[^a-z0-9])(?:1\s*oz|oz|ounce)(?![a-z0-9])/i, grams: 28 },
  { re: /(?:^|[^a-z0-9.])14\s*g(?![a-z0-9])/i, grams: 14 },
  { re: /(?:^|[^a-z0-9])(?:1\/2\s*oz|half\s*oz|half\s*ounce)(?![a-z0-9])/i, grams: 14 },
  { re: /(?:^|[^a-z0-9.])7\s*g(?![a-z0-9])/i, grams: 7 },
  { re: /(?:^|[^a-z0-9])(?:1\/4\s*oz|quarter\s*oz|quarter\s*ounce|quarter)(?![a-z0-9])/i, grams: 7 },
  { re: /(?:^|[^a-z0-9.])3\.5\s*g(?![a-z0-9])/i, grams: 3.5 },
  { re: /(?:^|[^a-z0-9])(?:1\/8|eighth)(?![a-z0-9])/i, grams: 3.5 },
]

/**
 * Return the grams for the first recognized weight token across the given
 * strings (checked in order), or null when nothing matches confidently.
 */
export function parseWeightGrams(
  ...texts: (string | null | undefined)[]
): number | null {
  for (const t of texts) {
    if (!t) continue
    for (const r of RULES) if (r.re.test(t)) return r.grams
  }
  return null
}

/** Display label for a weight, e.g. 3.5 -> "3.5g", 28 -> "28g". */
export function weightLabel(grams: number): string {
  return `${Math.round(grams * 100) / 100}g`
}

/**
 * Split a flattened product name of the form "Strain - 3.5g" into its strain
 * base and grams. Only the " - <weight>" suffix our own sync produced is
 * recognized (precise on purpose); anything else returns grams = null so it is
 * left out of the backfill rather than mis-grouped.
 */
export function stripWeightSuffix(name: string): {
  strain: string
  grams: number | null
} {
  const parts = (name ?? "").split(/\s+-\s+/)
  if (parts.length >= 1) {
    const last = parts[parts.length - 1]
    const g = parseWeightGrams(last)
    if (g != null) {
      return { strain: parts.slice(0, -1).join(" - ").trim(), grams: g }
    }
  }
  return { strain: (name ?? "").trim(), grams: null }
}

/**
 * A self-describing display name for a child SKU: the strain parent with any
 * leftover weight suffix stripped, plus the child's own weight/variant, so a
 * flat inventory/outbound list tells you the actual product at a glance
 * (e.g. parent "Blue Slushie - Indica - 28G" + a 7g child -> "Blue Slushie -
 * Indica · 7g"; a promo child -> "Blue Slushie - Indica · Ounce Special").
 * Falls back to the raw name if there's no variant to append.
 */
export function childDisplayName(
  productName: string | null | undefined,
  variantLabel?: string | null,
  gramsPerUnit?: number | string | null,
): string {
  const raw = (productName ?? "").trim()
  const strain = stripWeightSuffix(raw).strain || raw
  const grams =
    gramsPerUnit == null || gramsPerUnit === "" ? null : Number(gramsPerUnit)
  const variant =
    (variantLabel ?? "").trim() ||
    (grams != null && Number.isFinite(grams) ? weightLabel(grams) : "")
  return variant ? `${strain} · ${variant}` : strain
}
