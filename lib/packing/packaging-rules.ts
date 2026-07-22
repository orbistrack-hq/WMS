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

/**
 * One unit line: how many units at a given per-unit weight. `childSkuId` is
 * optional and only used by the FB-6 SKU-override path (migration 0080): when a
 * unit's child SKU has an override, it uses that packaging instead of its
 * weight-derived packaging. Callers that don't care about overrides can omit it.
 */
export type WeightedUnit = {
  gramsPerUnit: number | null
  qty: number
  childSkuId?: string | null
}

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

// ---------------------------------------------------------------------------
// Weight → packaging config engine (FB-6, migration 0046)
// ---------------------------------------------------------------------------
// Supersedes the single jar/bag threshold: packaging cost now varies by weight
// AND dimension (7g and 14g use different-sized/cost Mylar bags), plus a set of
// per-ORDER defaults (box, label, vacuum sealed bag) applied once per group.
// `computeOrderPackaging` is a pure function over config loaded from the DB, so
// it's fully testable and the server just feeds it rows.

/** A row of packaging_weight_rule joined to its type's cost. */
export type PackagingWeightRule = {
  gramsPerUnit: number
  typeId: string
  typeName: string
  kind: string
  unitCost: number
  qtyPerUnit: number
}

/** A row of packaging_order_default joined to its type's cost. */
export type PackagingOrderDefault = {
  typeId: string
  typeName: string
  kind: string
  unitCost: number
  qty: number
}

/**
 * A row of packaging_sku_rule joined to its type's cost (migration 0080). A
 * per-child-SKU override: units of `childSkuId` use these packaging types per
 * unit INSTEAD of their weight-derived packaging.
 */
export type PackagingSkuRule = {
  childSkuId: string
  typeId: string
  typeName: string
  kind: string
  unitCost: number
  qtyPerUnit: number
}

export type ComputedPackagingLine = {
  typeId: string
  typeName: string
  kind: string
  qty: number
  unitCost: number
  lineCost: number
}

export type ComputedPackaging = {
  lines: ComputedPackagingLine[]
  totalCost: number
  /** Units whose weight matched no rule (or had no weight) — flagged, not guessed. */
  unknownWeightUnits: number
}

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100

// Stable display/aggregation order for packaging lines.
const KIND_SORT: Record<string, number> = {
  box: 0,
  shipping_label: 1,
  jar: 2,
  jar_label: 3,
  vacuum_bag: 4,
  mylar_bag: 5,
  custom: 6,
}

/**
 * Compute the packaging (and cost) for one order/group from the weight map +
 * per-order defaults, with optional per-SKU overrides.
 *
 * For each unit line: if its child SKU has any override rule (migration 0080),
 * those rules supply the per-unit packaging and the weight rule is SKIPPED for
 * that unit (an override replaces, it doesn't stack). Otherwise the unit is
 * matched to weight rules by EXACT grams_per_unit. Per-order defaults are added
 * once. Lines are aggregated by packaging type. A unit with no override AND no
 * matching weight rule (or no weight) is surfaced in `unknownWeightUnits` rather
 * than silently mis-packed — but an override always counts, even with no weight.
 */
export function computeOrderPackaging(
  units: WeightedUnit[],
  weightRules: PackagingWeightRule[],
  orderDefaults: PackagingOrderDefault[],
  skuRules: PackagingSkuRule[] = [],
): ComputedPackaging {
  const byType = new Map<
    string,
    { typeName: string; kind: string; unitCost: number; qty: number }
  >()
  const add = (
    typeId: string,
    typeName: string,
    kind: string,
    unitCost: number,
    qty: number,
  ) => {
    if (qty <= 0) return
    const e = byType.get(typeId) ?? { typeName, kind, unitCost, qty: 0 }
    e.qty += qty
    byType.set(typeId, e)
  }

  const rulesByGrams = new Map<number, PackagingWeightRule[]>()
  for (const r of weightRules) {
    const arr = rulesByGrams.get(r.gramsPerUnit) ?? []
    arr.push(r)
    rulesByGrams.set(r.gramsPerUnit, arr)
  }

  const overridesByChild = new Map<string, PackagingSkuRule[]>()
  for (const r of skuRules) {
    const arr = overridesByChild.get(r.childSkuId) ?? []
    arr.push(r)
    overridesByChild.set(r.childSkuId, arr)
  }

  let unknown = 0
  for (const u of units) {
    if (u.qty <= 0) continue
    // Per-SKU override wins and REPLACES the weight rule for this unit. It counts
    // even when the SKU has no weight, so an override SKU is never "unknown".
    const overrides = u.childSkuId
      ? overridesByChild.get(u.childSkuId)
      : undefined
    if (overrides && overrides.length > 0) {
      for (const r of overrides) {
        add(r.typeId, r.typeName, r.kind, r.unitCost, r.qtyPerUnit * u.qty)
      }
      continue
    }
    if (u.gramsPerUnit == null) {
      unknown += u.qty
      continue
    }
    const rules = rulesByGrams.get(u.gramsPerUnit)
    if (!rules || rules.length === 0) {
      unknown += u.qty
      continue
    }
    for (const r of rules) {
      add(r.typeId, r.typeName, r.kind, r.unitCost, r.qtyPerUnit * u.qty)
    }
  }

  // Per-order defaults: once per order/group.
  for (const d of orderDefaults) {
    add(d.typeId, d.typeName, d.kind, d.unitCost, d.qty)
  }

  const lines: ComputedPackagingLine[] = [...byType.entries()]
    .map(([typeId, e]) => ({
      typeId,
      typeName: e.typeName,
      kind: e.kind,
      qty: e.qty,
      unitCost: e.unitCost,
      lineCost: round2(e.qty * e.unitCost),
    }))
    .sort(
      (a, b) =>
        (KIND_SORT[a.kind] ?? 99) - (KIND_SORT[b.kind] ?? 99) ||
        a.typeName.localeCompare(b.typeName),
    )

  const totalCost = round2(lines.reduce((s, l) => s + l.lineCost, 0))
  return { lines, totalCost, unknownWeightUnits: unknown }
}

// ---------------------------------------------------------------------------
// Top-up reconciliation (re-apply autofill after a missing weight is filled in)
// ---------------------------------------------------------------------------
// When a child SKU had no weight at pack time, its units fell into
// `unknownWeightUnits` and got no jar/bag — the group was packed with too few
// consumables. After the weight is corrected in the catalog, `topUpLines`
// recomputes the target and returns only the lines to ADD to bring each
// consumable kind up to that target: never removing, never exceeding. It
// reconciles by KIND (not packaging type) so an operator who already recorded a
// different jar type isn't double-counted, and box/label (already at target)
// are left alone. This is the "top up only" re-apply — forgiving of manual edits.

/** What's already recorded on the group, summed per packaging kind. */
export type RecordedKindQty = { kind: string; quantity: number }

export type TopUpLine = {
  typeId: string
  typeName: string
  kind: string
  qty: number
}

/**
 * Given a freshly-computed target packaging and what's already recorded (by
 * kind), return the add-only lines that raise each kind to its target. Kinds
 * already at or above target yield nothing. The packaging type used for a
 * deficit is the first computed line of that kind (i.e. the config's choice).
 */
export function topUpLines(
  computed: ComputedPackaging,
  recorded: RecordedKindQty[],
): TopUpLine[] {
  const recordedByKind = new Map<string, number>()
  for (const r of recorded)
    recordedByKind.set(r.kind, (recordedByKind.get(r.kind) ?? 0) + r.quantity)

  const firstByKind = new Map<string, ComputedPackagingLine>()
  const desiredByKind = new Map<string, number>()
  for (const l of computed.lines) {
    if (!firstByKind.has(l.kind)) firstByKind.set(l.kind, l)
    desiredByKind.set(l.kind, (desiredByKind.get(l.kind) ?? 0) + l.qty)
  }

  const out: TopUpLine[] = []
  for (const [kind, desired] of desiredByKind) {
    const deficit = desired - (recordedByKind.get(kind) ?? 0)
    if (deficit <= 0) continue
    const t = firstByKind.get(kind)
    if (!t) continue
    out.push({ typeId: t.typeId, typeName: t.typeName, kind, qty: deficit })
  }
  return out
}
