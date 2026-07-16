import { describe, expect, it } from "vitest"

import {
  aggregatePickLines,
  comparePickRoute,
  type PickLine,
  type PickOrderRow,
} from "./aggregate"

const line = (over: Partial<PickLine>): PickLine => ({
  childSkuId: null,
  sku: null,
  bin: null,
  barcode: null,
  name: "—",
  qty: 1,
  gramsPerUnit: null,
  ...over,
})

describe("comparePickRoute", () => {
  it("orders by bin first", () => {
    expect(
      comparePickRoute(line({ bin: "A1" }), line({ bin: "B2" })),
    ).toBeLessThan(0)
  })

  it("puts rows with a bin ahead of rows without", () => {
    expect(comparePickRoute(line({ bin: "Z9" }), line({ bin: null }))).toBe(-1)
    expect(comparePickRoute(line({ bin: null }), line({ bin: "A1" }))).toBe(1)
  })

  it("falls back to sku, then name", () => {
    expect(
      comparePickRoute(line({ sku: "S1" }), line({ sku: "S2" })),
    ).toBeLessThan(0)
    expect(
      comparePickRoute(line({ name: "Apple" }), line({ name: "Banana" })),
    ).toBeLessThan(0)
  })
})

describe("aggregatePickLines", () => {
  const childLine = (
    id: string | null,
    sku: string | null,
    bin: string | null,
    name: string | null,
    quantity: number,
  ) => ({
    quantity,
    child_sku: id
      ? {
          id,
          sku,
          bin_location: bin,
          barcode: null,
          product: { name },
        }
      : null,
  })

  const orders: PickOrderRow[] = [
    {
      order_number: "ORD-1",
      status: "picking",
      order_line_items: [
        childLine("c1", "S1", "B2", "Prod One", 2),
        childLine("c2", "S2", "A1", "Prod Two", 1),
      ],
    },
    {
      order_number: "ORD-2",
      status: "created",
      order_line_items: [
        childLine("c1", "S1", "B2", "Prod One", 3), // merges with c1
        childLine(null, null, null, null, 1), // orphaned line
      ],
    },
    {
      order_number: "ORD-3",
      status: "cancelled", // not an active pick status → skipped
      order_line_items: [childLine("c9", "S9", "A0", "Nope", 9)],
    },
  ]

  it("includes only active orders", () => {
    const { orderNumbers } = aggregatePickLines(orders)
    expect(orderNumbers).toEqual(["ORD-1", "ORD-2"])
  })

  it("merges quantities across orders by child SKU", () => {
    const { lines } = aggregatePickLines(orders)
    const c1 = lines.find((l) => l.childSkuId === "c1")
    expect(c1?.qty).toBe(5)
  })

  it("sorts into walking-route order (bin first, blanks last)", () => {
    const { lines } = aggregatePickLines(orders)
    expect(lines.map((l) => l.childSkuId)).toEqual(["c2", "c1", null])
  })

  it("handles an orphaned line with a placeholder name and no bin", () => {
    const { lines } = aggregatePickLines(orders)
    const orphan = lines[lines.length - 1]
    expect(orphan.childSkuId).toBeNull()
    expect(orphan.name).toBe("—")
    expect(orphan.bin).toBeNull()
    expect(orphan.qty).toBe(1)
  })

  it("totals every active unit", () => {
    expect(aggregatePickLines(orders).totalUnits).toBe(7)
  })

  it("skips a held (on_hold) order even when its status is active", () => {
    const withHeld: PickOrderRow[] = [
      ...orders,
      {
        order_number: "ORD-HOLD",
        status: "created",
        on_hold: true,
        order_line_items: [childLine("c1", "S1", "B2", "Prod One", 4)],
      },
    ]
    const { orderNumbers, totalUnits } = aggregatePickLines(withHeld)
    expect(orderNumbers).toEqual(["ORD-1", "ORD-2"]) // ORD-HOLD excluded
    expect(totalUnits).toBe(7) // held units not added
  })

  it("returns an empty result when nothing is active", () => {
    const result = aggregatePickLines([
      { order_number: "ORD-X", status: "shipped", order_line_items: [] },
    ])
    expect(result).toEqual({ lines: [], orderNumbers: [], totalUnits: 0 })
  })
})
