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
