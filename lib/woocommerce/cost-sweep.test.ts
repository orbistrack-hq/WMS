import { describe, expect, it } from "vitest"

import { costUpdates } from "./cost-sweep"

describe("costUpdates", () => {
  const store = new Map<string, number>([
    ["10583", 2.73],
    ["10584", 5.47],
    ["555", 0],
  ])

  it("overwrites a drifted cost with the store's positive cost", () => {
    expect(
      costUpdates(store, [{ id: "a", store_variant_id: "10583", cost: 3.52 }]),
    ).toEqual([{ childSkuId: "a", storeVariantId: "10583", from: 3.52, to: 2.73 }])
  })

  it("reads numeric strings from PostgREST and fills an unset cost", () => {
    expect(
      costUpdates(store, [
        { id: "a", store_variant_id: "10584", cost: "7.03" },
        { id: "b", store_variant_id: "10583", cost: null },
      ]).map((u) => [u.childSkuId, u.from, u.to]),
    ).toEqual([
      ["a", 7.03, 5.47],
      ["b", 0, 2.73],
    ])
  })

  it("compares at cents, as numeric(12,2) stores the cost", () => {
    const fractional = new Map([["1", 9.765], ["2", 9.765]])
    expect(
      costUpdates(fractional, [
        { id: "stored", store_variant_id: "1", cost: "9.77" },
        { id: "stale", store_variant_id: "2", cost: "10.00" },
      ]),
    ).toEqual([{ childSkuId: "stale", storeVariantId: "2", from: 10, to: 9.77 }])
  })

  it("skips matching costs, zero store costs, unmapped and unknown children", () => {
    expect(
      costUpdates(store, [
        { id: "same", store_variant_id: "10583", cost: "2.73" },
        { id: "zero", store_variant_id: "555", cost: 4 },
        { id: "unmapped", store_variant_id: null, cost: 4 },
        { id: "not-in-store", store_variant_id: "999", cost: 4 },
      ]),
    ).toEqual([])
  })
})
