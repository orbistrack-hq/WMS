import { describe, expect, it } from "vitest"

import {
  JAR_MAX_GRAMS,
  computeOrderPackaging,
  derivePackagingForGroup,
  packagingKindForGrams,
  suggestedPackagingLines,
  tallyByWeight,
  topUpLines,
  type PackagingOrderDefault,
  type PackagingWeightRule,
  type RecordedKindQty,
  type WeightedUnit,
} from "./packaging-rules"

// Canonical weight→packaging config from migration 0046 (FB-6).
const WEIGHT_RULES: PackagingWeightRule[] = [
  { gramsPerUnit: 3.5, typeId: "jar", typeName: "3.5g Jar", kind: "jar", unitCost: 0.4, qtyPerUnit: 1 },
  { gramsPerUnit: 3.5, typeId: "jarlbl", typeName: "Jar Label", kind: "jar_label", unitCost: 0.03, qtyPerUnit: 1 },
  { gramsPerUnit: 7, typeId: "m1", typeName: "Mylar 4x6x2", kind: "mylar_bag", unitCost: 0.12, qtyPerUnit: 1 },
  { gramsPerUnit: 14, typeId: "m2", typeName: "Mylar 6x9x3", kind: "mylar_bag", unitCost: 0.2, qtyPerUnit: 1 },
  { gramsPerUnit: 28, typeId: "m2", typeName: "Mylar 6x9x3", kind: "mylar_bag", unitCost: 0.2, qtyPerUnit: 1 },
]
const ORDER_DEFAULTS: PackagingOrderDefault[] = [
  { typeId: "box", typeName: "Box", kind: "box", unitCost: 0.45, qty: 1 },
  { typeId: "lbl", typeName: "Label", kind: "shipping_label", unitCost: 0.03, qty: 1 },
  { typeId: "vac", typeName: "Vacuum Sealed Bag", kind: "vacuum_bag", unitCost: 0.5, qty: 1 },
]
const cQty = (id: string, r: ReturnType<typeof computeOrderPackaging>) =>
  r.lines.find((l) => l.typeId === id)?.qty ?? 0

const types = [
  { id: "t-box", name: "Standard box", kind: "box" },
  { id: "t-label", name: "Shipping label", kind: "shipping_label" },
  { id: "t-jar", name: "3.5g jar", kind: "jar" },
  { id: "t-jarlabel", name: "Jar label", kind: "jar_label" },
  { id: "t-bag", name: "Mylar bag", kind: "vacuum_bag" },
]

describe("packagingKindForGrams", () => {
  it("puts exactly 3.5g in a jar", () => {
    expect(packagingKindForGrams(3.5)).toBe("jar")
  })

  it("puts anything under 3.5g in a jar", () => {
    expect(packagingKindForGrams(1)).toBe("jar")
    expect(packagingKindForGrams(JAR_MAX_GRAMS)).toBe("jar")
  })

  it("puts anything above 3.5g in a bag", () => {
    expect(packagingKindForGrams(3.6)).toBe("vacuum_bag")
    expect(packagingKindForGrams(7)).toBe("vacuum_bag")
    expect(packagingKindForGrams(28)).toBe("vacuum_bag")
  })

  it("honours a custom threshold from settings (migration 0040)", () => {
    // With a 7g threshold, 7g jars and 14g bags.
    expect(packagingKindForGrams(7, 7)).toBe("jar")
    expect(packagingKindForGrams(14, 7)).toBe("vacuum_bag")
    expect(packagingKindForGrams(3.5, 7)).toBe("jar")
  })
})

describe("derivePackagingForGroup with a custom threshold", () => {
  it("re-classes weights against the passed threshold", () => {
    const d = derivePackagingForGroup(
      [
        { gramsPerUnit: 3.5, qty: 2 },
        { gramsPerUnit: 7, qty: 3 },
      ],
      7,
    )
    expect(d.jar).toBe(5) // both 3.5 and 7 now jarred
    expect(d.vacuum_bag).toBe(0)
  })
})

describe("derivePackagingForGroup", () => {
  it("gives one jar + one jar label per 3.5g unit", () => {
    const d = derivePackagingForGroup([{ gramsPerUnit: 3.5, qty: 4 }])
    expect(d.jar).toBe(4)
    expect(d.jar_label).toBe(4)
    expect(d.vacuum_bag).toBe(0)
  })

  it("gives one bag per heavier unit, no jar", () => {
    const d = derivePackagingForGroup([{ gramsPerUnit: 28, qty: 2 }])
    expect(d.vacuum_bag).toBe(2)
    expect(d.jar).toBe(0)
    expect(d.jar_label).toBe(0)
  })

  it("mixes jars and bags across weights in the same group", () => {
    const units: WeightedUnit[] = [
      { gramsPerUnit: 3.5, qty: 4 },
      { gramsPerUnit: 7, qty: 3 },
      { gramsPerUnit: 28, qty: 2 },
    ]
    const d = derivePackagingForGroup(units)
    expect(d.jar).toBe(4)
    expect(d.jar_label).toBe(4)
    expect(d.vacuum_bag).toBe(5) // 3 + 2
  })

  it("always counts exactly one box + one label per group (never per order)", () => {
    const d = derivePackagingForGroup([
      { gramsPerUnit: 3.5, qty: 10 },
      { gramsPerUnit: 28, qty: 10 },
    ])
    expect(d.box).toBe(1)
    expect(d.shipping_label).toBe(1)
  })

  it("surfaces unknown-weight units instead of mis-classing them", () => {
    const d = derivePackagingForGroup([
      { gramsPerUnit: null, qty: 3 },
      { gramsPerUnit: 3.5, qty: 1 },
    ])
    expect(d.unknownWeightUnits).toBe(3)
    expect(d.jar).toBe(1)
    expect(d.vacuum_bag).toBe(0)
  })

  it("ignores zero / negative quantities", () => {
    const d = derivePackagingForGroup([
      { gramsPerUnit: 3.5, qty: 0 },
      { gramsPerUnit: 28, qty: -2 },
    ])
    expect(d.jar).toBe(0)
    expect(d.vacuum_bag).toBe(0)
  })
})

describe("suggestedPackagingLines", () => {
  it("maps a mixed group to box + label + jars + jar labels + bags", () => {
    const derived = derivePackagingForGroup([
      { gramsPerUnit: 3.5, qty: 2 },
      { gramsPerUnit: 28, qty: 1 },
    ])
    const s = suggestedPackagingLines(derived, types)
    expect(s).toEqual([
      { typeId: "t-box", typeName: "Standard box", kind: "box", qty: 1 },
      {
        typeId: "t-label",
        typeName: "Shipping label",
        kind: "shipping_label",
        qty: 1,
      },
      { typeId: "t-jar", typeName: "3.5g jar", kind: "jar", qty: 2 },
      {
        typeId: "t-jarlabel",
        typeName: "Jar label",
        kind: "jar_label",
        qty: 2,
      },
      { typeId: "t-bag", typeName: "Mylar bag", kind: "vacuum_bag", qty: 1 },
    ])
  })

  it("skips kinds with zero qty", () => {
    const derived = derivePackagingForGroup([{ gramsPerUnit: 3.5, qty: 3 }])
    const kinds = suggestedPackagingLines(derived, types).map((s) => s.kind)
    expect(kinds).not.toContain("vacuum_bag")
    expect(kinds).toContain("jar")
  })

  it("skips a needed kind that has no configured packaging type", () => {
    const derived = derivePackagingForGroup([{ gramsPerUnit: 3.5, qty: 2 }])
    // No jar_label type available → jar labels can't be suggested.
    const noJarLabel = types.filter((t) => t.kind !== "jar_label")
    const kinds = suggestedPackagingLines(derived, noJarLabel).map((s) => s.kind)
    expect(kinds).toContain("jar")
    expect(kinds).not.toContain("jar_label")
  })

  it("uses the first type of each kind when several exist", () => {
    const derived = derivePackagingForGroup([{ gramsPerUnit: 28, qty: 1 }])
    const dupBags = [
      ...types,
      { id: "t-bag2", name: "Big bag", kind: "vacuum_bag" },
    ]
    const bag = suggestedPackagingLines(derived, dupBags).find(
      (s) => s.kind === "vacuum_bag",
    )
    expect(bag?.typeId).toBe("t-bag")
  })
})

describe("tallyByWeight", () => {
  it("counts units per weight, lightest first", () => {
    const t = tallyByWeight([
      { gramsPerUnit: 28, qty: 2 },
      { gramsPerUnit: 3.5, qty: 4 },
      { gramsPerUnit: 3.5, qty: 1 },
      { gramsPerUnit: 7, qty: 3 },
    ])
    expect(t).toEqual([
      { grams: 3.5, units: 5 },
      { grams: 7, units: 3 },
      { grams: 28, units: 2 },
    ])
  })

  it("sorts unknown weights last", () => {
    const t = tallyByWeight([
      { gramsPerUnit: null, qty: 2 },
      { gramsPerUnit: 3.5, qty: 1 },
    ])
    expect(t[t.length - 1]).toEqual({ grams: null, units: 2 })
  })
})

describe("computeOrderPackaging (FB-6 weight+dimension config)", () => {
  it("prices a mixed 3.5 / 7 / 28g order + per-order defaults", () => {
    const r = computeOrderPackaging(
      [
        { gramsPerUnit: 3.5, qty: 4 },
        { gramsPerUnit: 7, qty: 2 },
        { gramsPerUnit: 28, qty: 1 },
      ],
      WEIGHT_RULES,
      ORDER_DEFAULTS,
    )
    expect(cQty("jar", r)).toBe(4)
    expect(cQty("jarlbl", r)).toBe(4)
    expect(cQty("m1", r)).toBe(2) // 7g → small Mylar
    expect(cQty("m2", r)).toBe(1) // 28g → large Mylar
    expect(cQty("box", r)).toBe(1)
    expect(cQty("vac", r)).toBe(1)
    expect(r.totalCost).toBe(3.14)
    expect(r.unknownWeightUnits).toBe(0)
  })

  it("charges the different Mylar sizes (7g=0.12 vs 14g=0.20)", () => {
    const r = computeOrderPackaging(
      [
        { gramsPerUnit: 7, qty: 1 },
        { gramsPerUnit: 14, qty: 1 },
      ],
      WEIGHT_RULES,
      ORDER_DEFAULTS,
    )
    expect(r.lines.find((l) => l.typeId === "m1")?.lineCost).toBe(0.12)
    expect(r.lines.find((l) => l.typeId === "m2")?.lineCost).toBe(0.2)
  })

  it("counts per-order defaults once regardless of unit count", () => {
    const r = computeOrderPackaging(
      [{ gramsPerUnit: 3.5, qty: 10 }],
      WEIGHT_RULES,
      ORDER_DEFAULTS,
    )
    expect(cQty("box", r)).toBe(1)
    expect(cQty("vac", r)).toBe(1)
    expect(cQty("jar", r)).toBe(10)
  })

  it("uses EXACT weight match — an off weight is unknown, not mis-packed", () => {
    const r = computeOrderPackaging(
      [
        { gramsPerUnit: 3.6, qty: 2 },
        { gramsPerUnit: null, qty: 1 },
        { gramsPerUnit: 3.5, qty: 1 },
      ],
      WEIGHT_RULES,
      ORDER_DEFAULTS,
    )
    expect(r.unknownWeightUnits).toBe(3)
    expect(cQty("jar", r)).toBe(1)
  })
})

describe("topUpLines (re-apply after a weight is filled in)", () => {
  // Scenario: a 3.5g line was packed while its SKU had no weight, so only the
  // per-order defaults (box, label, vacuum bag) were recorded — the jars/labels
  // were dropped. Now the weight is set; top-up should add exactly the missing
  // jars + jar labels and nothing else.
  const target = computeOrderPackaging(
    [{ gramsPerUnit: 3.5, qty: 3 }],
    WEIGHT_RULES,
    ORDER_DEFAULTS,
  )

  it("adds only the consumables that were dropped, leaving box/label/bag alone", () => {
    const recorded: RecordedKindQty[] = [
      { kind: "box", quantity: 1 },
      { kind: "shipping_label", quantity: 1 },
      { kind: "vacuum_bag", quantity: 1 },
    ]
    const add = topUpLines(target, recorded)
    const byKind = Object.fromEntries(add.map((l) => [l.kind, l.qty]))
    expect(byKind).toEqual({ jar: 3, jar_label: 3 })
  })

  it("returns nothing when everything is already at target", () => {
    const recorded: RecordedKindQty[] = [
      { kind: "box", quantity: 1 },
      { kind: "shipping_label", quantity: 1 },
      { kind: "vacuum_bag", quantity: 1 },
      { kind: "jar", quantity: 3 },
      { kind: "jar_label", quantity: 3 },
    ]
    expect(topUpLines(target, recorded)).toEqual([])
  })

  it("never removes or exceeds — an over-recorded kind is left untouched", () => {
    const recorded: RecordedKindQty[] = [
      { kind: "box", quantity: 2 }, // operator added a second box by hand
      { kind: "jar", quantity: 5 }, // more jars than target
    ]
    const add = topUpLines(target, recorded)
    expect(add.find((l) => l.kind === "box")).toBeUndefined()
    expect(add.find((l) => l.kind === "jar")).toBeUndefined()
    // The still-missing consumables/defaults are the ones topped up.
    expect(add.find((l) => l.kind === "jar_label")?.qty).toBe(3)
    expect(add.find((l) => l.kind === "shipping_label")?.qty).toBe(1)
  })

  it("reconciles by kind: a different jar type already covers the need", () => {
    // Recorded jars are a different packaging type but same 'jar' kind — the
    // count is what matters, so no more jars are added.
    const recorded: RecordedKindQty[] = [{ kind: "jar", quantity: 3 }]
    const add = topUpLines(target, recorded)
    expect(add.find((l) => l.kind === "jar")).toBeUndefined()
  })

  it("tops up partially when some of a kind is recorded", () => {
    const recorded: RecordedKindQty[] = [{ kind: "jar", quantity: 1 }]
    const add = topUpLines(target, recorded)
    expect(add.find((l) => l.kind === "jar")?.qty).toBe(2) // 3 target − 1
  })
})
