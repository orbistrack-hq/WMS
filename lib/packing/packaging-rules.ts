// ---------------------------------------------------------------------------
// Weight-based packaging derivation (FB-3)
// ---------------------------------------------------------------------------
// Rule (global, confirmed 2026-07-07): a 3.5g unit goes in a JAR (+ one jar
// label); ANY unit heavier than 3.5g goes in ONE Mylar / vacuum bag — never a
// jar. Every fulfillment group also gets 1 box + 1 shipping label, counted
// ONCE per group (combined orders share the single box/label — never per order).
//
// This is a SEED, not a lock: the pack / wave UI pre-fills these numbers and the
// operator can edit any of them before confirming, since packaging genuinely
// varies. Keyed on the child SKU's grams_per_unit — a product attribute carried
// on every order line — so it is independent of the central-inventory /
// delegation model (FB-1): the weight is known from the order regardless of
// where the stock currently sits.
//
// There is deliberately no lookup table: the rule is a single threshold. If the
// client later supplies a richer map, swap `packagingKindForGrams` for a
// config-driven lookup — everything downstream keys off its output.

/**
 * Default at-or-below-this-weight → jar threshold (grams). This is the in-code
 * fallback; the live value is admin-editable and stored in `packaging_rule`
 * (migration 0040). Server components read the DB value and pass it in; the
 * pure helpers below fall back to this constant when no value is supplied.
 */
export const JAR_MAX_GRAMS = 3.5

/** One unit line: how many units at a given per-unit weight. */
export type WeightedUnit = { gramsPerUnit: number | null; qty: number }

export type DerivedPackaging = {
  jar: number
  jar_label: number
  vacuum_bag: number
  box: number
  shipping_label: number
  /** Units whose weight is unknown (null grams_per_unit); not auto-classed. */
  unknownWeightUnits: number
}

/** The consumable a single unit of this weight needs. */
export function packagingKindForGrams(
  gramsPerUnit: number,
  jarMaxGrams: number = JAR_MAX_GRAMS,
): "jar" | "vacuum_bag" {
  return gramsPerUnit <= jarMaxGrams ? "jar" : "vacuum_bag"
}

/**
 * Derive seeded packaging for ONE fulfillment group from its unit lines.
 * jars / jar labels / bags scale with units; box + label are 1 per group.
 * Units with unknown weight are surfaced in `unknownWeightUnits` and left for
 * the operator to add by hand rather than silently mis-classed.
 */
export function derivePackagingForGroup(
  units: WeightedUnit[],
  jarMaxGrams: number = JAR_MAX_GRAMS,
): DerivedPackaging {
  let jar = 0
  let bag = 0
  let unknown = 0
  for (const u of units) {
    if (u.qty <= 0) continue
    if (u.gramsPerUnit == null) {
      unknown += u.qty
      continue
    }
    if (packagingKindForGrams(u.gramsPerUnit, jarMaxGrams) === "jar") jar += u.qty
    else bag += u.qty
  }
  return {
    jar,
    jar_label: jar, // one label per jar
    vacuum_bag: bag,
    box: 1,
    shipping_label: 1,
    unknownWeightUnits: unknown,
  }
}

export type PackagingKindType = { id: string; name: string; kind: string }
export type SuggestedPackagingLine = {
  typeId: string
  typeName: string
  kind: string
  qty: number
}

/**
 * Turn a group's derived packaging counts into concrete "record this" lines by
 * matching each needed kind to the first available packaging type of that kind.
 * Kinds with zero qty, or with no configured packaging type, are skipped.
 * Powers the pack screen's one-click "apply suggested packaging" for a group
 * that has nothing recorded yet. Box + label come first, then jar/label/bag.
 */
export function suggestedPackagingLines(
  derived: DerivedPackaging,
  types: PackagingKindType[],
): SuggestedPackagingLine[] {
  const firstByKind = new Map<string, PackagingKindType>()
  for (const t of types) if (!firstByKind.has(t.kind)) firstByKind.set(t.kind, t)

  const order: [keyof DerivedPackaging, string][] = [
    ["box", "box"],
    ["shipping_label", "shipping_label"],
    ["jar", "jar"],
    ["jar_label", "jar_label"],
    ["vacuum_bag", "vacuum_bag"],
  ]
  const out: SuggestedPackagingLine[] = []
  for (const [field, kind] of order) {
    const qty = derived[field]
    if (typeof qty !== "number" || qty <= 0) continue
    const t = firstByKind.get(kind)
    if (!t) continue
    out.push({ typeId: t.id, typeName: t.name, kind, qty })
  }
  return out
}

/** One weight bucket for the wave breakdown: how many units at this weight. */
export type WeightTally = { grams: number | null; units: number }

/**
 * Count units grouped by exact per-unit weight, lightest first (unknown last).
 * Drives the "3.5g × N · 28g × M" breakdown section on the wave printout.
 */
export function tallyByWeight(units: WeightedUnit[]): WeightTally[] {
  const m = new Map<number | null, number>()
  for (const u of units) {
    if (u.qty <= 0) continue
    m.set(u.gramsPerUnit, (m.get(u.gramsPerUnit) ?? 0) + u.qty)
  }
  return [...m.entries()]
    .map(([grams, units]) => ({ grams, units }))
    .sort((a, b) => {
      if (a.grams == null) return 1
      if (b.grams == null) return -1
      return a.grams - b.grams
    })
}
