import { describe, expect, it } from "vitest"

import {
  addDays,
  gramsUsed,
  gramsWithPounds,
  potLabel,
  presetPeriod,
  suggestFill,
  toGrams,
} from "./shake"

const SIZES = [
  { id: "14", gramsPerUnit: 14 },
  { id: "28", gramsPerUnit: 28 },
  { id: "qp", gramsPerUnit: 112 },
]

describe("suggestFill", () => {
  it("fills biggest size first and never goes over the target", () => {
    for (const target of [0, 13, 14, 55, 111, 112, 500, 900, 1234.56]) {
      const used = gramsUsed(suggestFill(target, SIZES), SIZES)
      expect(used).toBeLessThanOrEqual(target)
      expect(target - used).toBeLessThan(14) // leftover is under the smallest size
    }
  })

  it("uses what's left on smaller sizes", () => {
    // 900 = 8 x 112 (896) + 4 left -> nothing smaller fits.
    expect(suggestFill(900, SIZES)).toEqual({ qp: 8 })
    // 1,000 = 8 x 112 (896) + 104 -> 3 x 28 (84) + 20 -> 1 x 14.
    expect(suggestFill(1000, SIZES)).toEqual({ qp: 8, "28": 3, "14": 1 })
    expect(gramsUsed(suggestFill(1000, SIZES), SIZES)).toBe(994)
  })

  it("returns nothing when the target is under the smallest size", () => {
    expect(suggestFill(13.99, SIZES)).toEqual({})
    expect(suggestFill(0, SIZES)).toEqual({})
  })

  it("handles exact fits and fractional targets", () => {
    expect(suggestFill(112, SIZES)).toEqual({ qp: 1 })
    expect(suggestFill(41.99, SIZES)).toEqual({ "28": 1 })
  })
})

describe("weights", () => {
  it("weighs shake on a 454 g pound", () => {
    expect(toGrams(1, "lb")).toBe(454)
    expect(toGrams(50, "lb")).toBe(22700)
    expect(toGrams(16, "oz")).toBe(454)
    expect(toGrams(2.5, "oz")).toBe(70.94)
    expect(toGrams(12.345, "g")).toBe(12.35)
  })

  it("adds pounds once it's at least a quarter pound", () => {
    expect(gramsWithPounds(84)).toBe("84g")
    expect(gramsWithPounds(113)).toBe("113g")
    expect(gramsWithPounds(1362)).toBe("1,362g (3.00 lb)")
  })
})

describe("presetPeriod", () => {
  const today = "2026-11-06"

  it("covers the usual windows, inclusive of today", () => {
    expect(presetPeriod("7d", today, null)).toEqual({ from: "2026-10-31", to: today })
    expect(presetPeriod("30d", today, null)).toEqual({ from: "2026-10-08", to: today })
    expect(presetPeriod("month", today, null)).toEqual({ from: "2026-11-01", to: today })
  })

  it("starts the day after the last split", () => {
    expect(presetPeriod("since_last", today, "2026-10-31")).toEqual({
      from: "2026-11-01",
      to: today,
    })
  })

  it("falls back to 30 days with no earlier split or one ending today", () => {
    expect(presetPeriod("since_last", today, null).from).toBe("2026-10-08")
    expect(presetPeriod("since_last", today, today).from).toBe("2026-10-08")
  })

  it("adds days across month and year ends", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01")
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28")
  })
})

describe("potLabel", () => {
  it("labels the screen pots and the hidden premium pot", () => {
    expect(potLabel("light_dep")).toBe("Light dep")
    expect(potLabel("premium")).toBe("Premium")
  })
})
