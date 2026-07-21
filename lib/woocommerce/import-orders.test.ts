import { describe, expect, it } from "vitest"

import { RETRYABLE_IMPORT_STATUSES, shouldRetryImport } from "./import-orders"

// The crux of the "shipped in the store but never landed in WMS" fix: on an
// idempotency-key clash, a genuine duplicate (already produced a WMS order) must
// never re-import, but a non-imported tombstone left by an earlier attempt must
// be retried so a later, complete webhook can land the order.
describe("shouldRetryImport", () => {
  it("retries a non-imported error tombstone (e.g. early empty-payload webhook)", () => {
    expect(shouldRetryImport({ status: "error", wms_order_id: null })).toBe(true)
  })

  it("retries a non-imported needs_mapping tombstone (items not yet synced)", () => {
    expect(
      shouldRetryImport({ status: "needs_mapping", wms_order_id: null }),
    ).toBe(true)
  })

  it("does NOT re-import a row that already produced a WMS order", () => {
    // Even if the status somehow reads error/needs_mapping, a set wms_order_id
    // means an order exists — re-importing would double it.
    expect(shouldRetryImport({ status: "error", wms_order_id: "ord-1" })).toBe(
      false,
    )
    expect(
      shouldRetryImport({ status: "imported", wms_order_id: "ord-1" }),
    ).toBe(false)
  })

  it("does NOT stomp an in-flight (received) or terminal (skipped/duplicate) row", () => {
    expect(shouldRetryImport({ status: "received", wms_order_id: null })).toBe(
      false,
    )
    expect(shouldRetryImport({ status: "skipped", wms_order_id: null })).toBe(
      false,
    )
    expect(shouldRetryImport({ status: "duplicate", wms_order_id: null })).toBe(
      false,
    )
  })

  it("handles a missing/unknown existing row defensively", () => {
    expect(shouldRetryImport(null)).toBe(false)
    expect(shouldRetryImport(undefined)).toBe(false)
    expect(shouldRetryImport({ status: null, wms_order_id: null })).toBe(false)
  })

  it("only error and needs_mapping are retryable", () => {
    expect([...RETRYABLE_IMPORT_STATUSES].sort()).toEqual([
      "error",
      "needs_mapping",
    ])
  })
})
