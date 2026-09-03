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

// Gram tiers we will accept written as a number ("3.5g", "224 g", "14 grams").
// An ALLOW-LIST on purpose: a bare number is only a weight if it is a weight we
// actually sell. That keeps "280g" unparsed (see the boundary test) rather than
// inventing a tier from whatever digits happen to sit next to a "g".
const GRAM_TIERS = [1, 2, 3.5, 5, 7, 10, 14, 28, 56, 112, 224, 448]

// Unit spellings. Separators are deliberately loose: WooCommerce hands us the
// attribute SLUG, so "1/2 lb" arrives as "1-2-lb" (this is what silently turned
// Bud Club's half pound into a full pound — see migration 0108).
const LB = "(?:lbs?|pounds?)"
const OZ = "(?:oz|ounces?)"
const SEP = "[-_\\s]*"          // between a quantity and its unit
const FRAC = "[-_/\\s]*"        // inside a fraction: 1/2, 1-2, "1 / 2"

function tierRule(g: number): Rule {
  const num = String(g).replace(".", "\\.")
  // The leading boundary blocks a DIGIT or a "." but allows a letter, because
  // our own SKU codes glue the number to the code ("OZ-SR14G", "BC-SR3.5G").
  // Blocking digits is what keeps "280g" unparsed and stops "5g" being read
  // out of "3.5g".
  return {
    re: new RegExp(`(?:^|[^0-9.])(${num}${SEP}(?:grams?|gs?|g))(?![a-z0-9])`, "gi"),
    grams: g,
  }
}

// Every recognized token, each with ONE capture group holding the token itself
// (the leading boundary character is outside it so it does not skew length).
// Order here does NOT decide the winner any more — see pickWeight below.
const RULES: Rule[] = [
  // Pound and fractions of a pound.
  { re: new RegExp(`(?:^|[^a-z0-9])((?:1${FRAC}2|half|½)${SEP}${LB})(?![a-z0-9])`, "gi"), grams: 224 },
  { re: new RegExp(`(?:^|[^a-z0-9])((?:1${FRAC}4|quarter|¼)${SEP}${LB})(?![a-z0-9])`, "gi"), grams: 112 },
  { re: new RegExp(`(?:^|[^a-z0-9])((?:1|full)${SEP}${LB})(?![a-z0-9])`, "gi"), grams: 448 },
  { re: new RegExp(`(?:^|[^a-z0-9])(${LB})(?![a-z0-9])`, "gi"), grams: 448 },
  // Trade shorthand, as used in our own SKU codes (…-BOX-QP).
  { re: /(?:^|[^a-z0-9])(hp)(?![a-z0-9])/gi, grams: 224 },
  { re: /(?:^|[^a-z0-9])(qp)(?![a-z0-9])/gi, grams: 112 },
  { re: /(?:^|[^a-z0-9])(fp)(?![a-z0-9])/gi, grams: 448 },
  // Ounce multiples that name a pound fraction.
  { re: new RegExp(`(?:^|[^a-z0-9])(16${SEP}${OZ})(?![a-z0-9])`, "gi"), grams: 448 },
  { re: new RegExp(`(?:^|[^a-z0-9])(8${SEP}${OZ})(?![a-z0-9])`, "gi"), grams: 224 },
  { re: new RegExp(`(?:^|[^a-z0-9])(4${SEP}${OZ})(?![a-z0-9])`, "gi"), grams: 112 },
  // Ounce and fractions of an ounce.
  { re: new RegExp(`(?:^|[^a-z0-9])((?:1${FRAC}2|half|½)${SEP}${OZ})(?![a-z0-9])`, "gi"), grams: 14 },
  { re: new RegExp(`(?:^|[^a-z0-9])((?:1${FRAC}4|quarter|¼)${SEP}${OZ})(?![a-z0-9])`, "gi"), grams: 7 },
  { re: new RegExp(`(?:^|[^a-z0-9])((?:1${SEP})?${OZ})(?![a-z0-9])`, "gi"), grams: 28 },
  { re: /(?:^|[^a-z0-9])(quarter)(?![a-z0-9])/gi, grams: 7 },
  { re: /(?:^|[^a-z0-9])(1[-_/\s]*8|eighth|⅛)(?![a-z0-9])/gi, grams: 3.5 },
  // Numeric tiers last in the list; longest-match still decides.
  ...GRAM_TIERS.map(tierRule),
]

/**
 * Best weight token in one string, or null.
 *
 * WHY LONGEST-MATCH, NOT FIRST-RULE: a real store string routinely contains two
 * weight tokens, one of which is a substring of the intent. Fixed rule order
 * picks whichever rule happens to sit higher in the list and gets these wrong:
 *
 *   "1-2-lb"     contains "1-2-lb" (224) and "lb"  (448) -> must be 224
 *   "OZ-SR3.5G"  contains "oz"     (28)  and "3.5g" (3.5) -> must be 3.5
 *   "half pound" contains "half pound" and "pound"        -> must be 224
 *
 * The longest token is the most specific one, so it wins. On a tie the
 * RIGHTMOST wins: our SKU codes carry the store prefix first and the weight
 * last ("OZ-SR-BOX-FP" is a full pound at OZPlug, not an ounce).
 */
function pickWeight(text: string): number | null {
  let best: { grams: number; len: number; end: number } | null = null
  for (const r of RULES) {
    r.re.lastIndex = 0
    for (const m of text.matchAll(r.re)) {
      const token = m[1] ?? ""
      const len = token.length
      const end = (m.index ?? 0) + m[0].length
      if (
        !best ||
        len > best.len ||
        (len === best.len && end > best.end)
      ) {
        best = { grams: r.grams, len, end }
      }
    }
  }
  return best ? best.grams : null
}

/**
 * Return the grams for the best recognized weight token across the given
 * strings, or null when nothing matches confidently.
 *
 * Arguments are checked IN ORDER and the first string that yields a weight
 * wins. Callers pass the store's own text before the SKU code deliberately:
 * a SKU prefix is not a weight ("OZ-…" is the OZPlug store, not an ounce), so
 * the SKU is only a fallback for when the store said nothing usable.
 */
export function parseWeightGrams(
  ...texts: (string | null | undefined)[]
): number | null {
  for (const t of texts) {
    if (!t) continue
    const g = pickWeight(t)
    if (g != null) return g
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
