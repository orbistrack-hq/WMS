import { describe, expect, it } from "vitest"

import { ssBeforeFloor } from "./reconcile"

const FLOOR = Date.parse("2026-07-10T00:00:00Z")

// Pre-launch orders were never meant to import into OT, so their absence from OT
// isn't a gap. ssBeforeFloor drives whether an SS-only order is hidden.
describe("ssBeforeFloor", () => {
  it("hides an order placed before the floor", () => {
    expect(ssBeforeFloor({ orderDate: "2026-07-05T12:00:00Z" }, FLOOR)).toBe(true)
  })

  it("keeps an order placed on/after the floor (boundary is inclusive-keep)", () => {
    expect(ssBeforeFloor({ orderDate: "2026-07-10T00:00:00Z" }, FLOOR)).toBe(false)
    expect(ssBeforeFloor({ orderDate: "2026-07-18T09:00:00Z" }, FLOOR)).toBe(false)
  })

  it("keeps everything when there is no floor", () => {
    expect(ssBeforeFloor({ orderDate: "2020-01-01T00:00:00Z" }, null)).toBe(false)
  })

  it("fails open for undated or unparseable orders (never hides them)", () => {
    expect(ssBeforeFloor({ orderDate: null }, FLOOR)).toBe(false)
    expect(ssBeforeFloor({}, FLOOR)).toBe(false)
    expect(ssBeforeFloor({ orderDate: "not-a-date" }, FLOOR)).toBe(false)
  })
})
