import { describe, expect, it } from "vitest"

import {
  JAR_MAX_GRAMS,
  derivePackagingForGroup,
  packagingKindForGrams,
  suggestedPackagingLines,
  tallyByWeight,
  type WeightedUnit,
} from "./packaging-rules"

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
