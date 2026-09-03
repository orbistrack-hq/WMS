import { describe, expect, it } from "vitest"

import { parseWeightGrams, stripWeightSuffix, weightLabel } from "./weight"

describe("parseWeightGrams", () => {
  it("parses gram tokens", () => {
    expect(parseWeightGrams("3.5g")).toBe(3.5)
    expect(parseWeightGrams("7g")).toBe(7)
    expect(parseWeightGrams("14g")).toBe(14)
    expect(parseWeightGrams("28g")).toBe(28)
  })

  it("parses fraction and word forms", () => {
    expect(parseWeightGrams("1/8")).toBe(3.5)
    expect(parseWeightGrams("eighth")).toBe(3.5)
    expect(parseWeightGrams("quarter")).toBe(7)
    expect(parseWeightGrams("1 oz")).toBe(28)
    expect(parseWeightGrams("1lb")).toBe(448)
    expect(parseWeightGrams("half pound")).toBe(224)
    expect(parseWeightGrams("qp")).toBe(112)
  })

  it("requires clean token boundaries", () => {
    // "28" inside "280g" must not read as 28g.
    expect(parseWeightGrams("280g")).toBeNull()
    // "oz" inside a word must not match.
    expect(parseWeightGrams("Ozzy")).toBeNull()
  })

  it("returns null when no weight is present", () => {
    expect(parseWeightGrams("Gorilla Glue")).toBeNull()
    expect(parseWeightGrams(null)).toBeNull()
    expect(parseWeightGrams(undefined, "")).toBeNull()
  })

  it("checks each argument in order and returns the first hit", () => {
    expect(parseWeightGrams(null, undefined, "7g")).toBe(7)
    expect(parseWeightGrams("Blue Dream", "3.5g")).toBe(3.5)
  })
})

// ---------------------------------------------------------------------------
// Regression: Bud Club "Super Runtz" half pound synced as a FULL pound
// (reported by J 2026-09-03). WooCommerce sends the attribute SLUG, so
// "1/2 lb" arrives as "1-2-lb"; the old fraction rule required a literal "/",
// missed it, and the generic pound rule then matched the bare "lb" and wrote
// 448. The child had already been allocated at the correct 224 four times, so
// only the weight field diverged from the label.
// ---------------------------------------------------------------------------
describe("parseWeightGrams — slugged and hyphenated fractions", () => {
  it("reads WooCommerce attribute slugs", () => {
    expect(parseWeightGrams("1-2-lb")).toBe(224)
    expect(parseWeightGrams("1-4-lb")).toBe(112)
    expect(parseWeightGrams("1lb")).toBe(448)
  })

  it("reads the same fraction however it is spelled", () => {
    for (const t of ["1/2 LB", "1/2lb", "half lb", "half-lb", "HALF POUND", "½ lb", "8oz"])
      expect(parseWeightGrams(t)).toBe(224)
    for (const t of ["1/4 lb", "1-4-lbs", "quarter lb", "QUARTER POUND", "¼ lb", "4oz"])
      expect(parseWeightGrams(t)).toBe(112)
    for (const t of ["1 lb", "1-lb", "full pound", "POUNDS", "16oz"])
      expect(parseWeightGrams(t)).toBe(448)
  })

  it("reads grams spelled out", () => {
    expect(parseWeightGrams("14 grams")).toBe(14)
    expect(parseWeightGrams("3.5 grams")).toBe(3.5)
    expect(parseWeightGrams("224g")).toBe(224)
  })
})

describe("parseWeightGrams — most specific token wins, not first rule", () => {
  it("prefers the longest token when a string holds two", () => {
    // "1-2-lb" also contains "lb"; "half pound" also contains "pound".
    expect(parseWeightGrams("1-2-lb")).toBe(224)
    expect(parseWeightGrams("half pound")).toBe(224)
    // "OZ-SR3.5G" contains "oz" AND "3.5g" — the weight is 3.5, not an ounce.
    expect(parseWeightGrams("OZ-SR3.5G")).toBe(3.5)
    expect(parseWeightGrams("OZ-SR14G")).toBe(14)
  })

  it("breaks a length tie on the rightmost token", () => {
    // Store prefix first, weight last: OZPlug's full-pound box is 448, and the
    // leading "OZ-" must not win it as an ounce.
    expect(parseWeightGrams("OZ-SR-BOX-FP")).toBe(448)
    expect(parseWeightGrams("OZ-SR-BOX-HP")).toBe(224)
    expect(parseWeightGrams("OZ-SR-BOX-QP")).toBe(112)
  })

  it("still refuses a number that is not a tier we sell", () => {
    expect(parseWeightGrams("280g")).toBeNull()
    expect(parseWeightGrams("Default Title")).toBeNull()
  })
})

describe("parseWeightGrams — store text beats the SKU code", () => {
  it("uses the store text when it parses, SKU only as fallback", () => {
    // Both importers call parseWeightGrams(storeText, sku) in this order.
    expect(parseWeightGrams("1-2-lb", "BC-SR-BOX-HP")).toBe(224)
    expect(parseWeightGrams("Default Title", "OZ-SR-OS")).toBe(28)
  })
})

describe("weightLabel", () => {
  it("renders grams with a g suffix", () => {
    expect(weightLabel(3.5)).toBe("3.5g")
    expect(weightLabel(28)).toBe("28g")
    expect(weightLabel(7)).toBe("7g")
  })

  it("rounds to two decimals", () => {
    expect(weightLabel(3.456)).toBe("3.46g")
  })
})

describe("stripWeightSuffix", () => {
  it("splits a 'Strain - weight' name", () => {
    expect(stripWeightSuffix("Blue Dream - 3.5g")).toEqual({
      strain: "Blue Dream",
      grams: 3.5,
    })
  })

  it("keeps only the trailing weight, preserving earlier dashes in the strain", () => {
    expect(stripWeightSuffix("OG Kush - Purple - 7g")).toEqual({
      strain: "OG Kush - Purple",
      grams: 7,
    })
  })

  it("returns the whole name with null grams when the suffix is not a weight", () => {
    expect(stripWeightSuffix("Just A Name - Blue")).toEqual({
      strain: "Just A Name - Blue",
      grams: null,
    })
    expect(stripWeightSuffix("Blue Dream")).toEqual({
      strain: "Blue Dream",
      grams: null,
    })
  })
})
