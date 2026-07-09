import { describe, expect, it } from "vitest"

import { cutoffQueryDate, isBeforeSyncCutoff } from "./cutoff"

/**
 * Order-sync floor tests.
 *
 * The floor is what keeps a store's historical orders out of WMS at go-live. It
 * governs BOTH the backfill and the webhook self-heal path, so these lock the
 * exact boundary behaviour the importers depend on — including the fail-open
 * rules (never silently drop a real order over a missing/bad date or no floor).
 */

const CUTOFF = "2026-07-09T00:00:00Z" // go-live: start of 2026-07-09 UTC

describe("isBeforeSyncCutoff", () => {
  it("skips orders created before the cutoff", () => {
    expect(isBeforeSyncCutoff("2026-07-08T23:59:59Z", CUTOFF)).toBe(true)
    expect(isBeforeSyncCutoff("2026-01-01T12:00:00Z", CUTOFF)).toBe(true)
  })

  it("keeps orders created at or after the cutoff (boundary inclusive)", () => {
    expect(isBeforeSyncCutoff("2026-07-09T00:00:00Z", CUTOFF)).toBe(false) // exactly at
    expect(isBeforeSyncCutoff("2026-07-09T00:00:01Z", CUTOFF)).toBe(false)
    expect(isBeforeSyncCutoff("2026-08-01T09:30:00Z", CUTOFF)).toBe(false)
  })

  it("compares instants, not strings — an offset stamp is normalized to UTC", () => {
    // 2026-07-08T20:30:00-04:00 === 2026-07-09T00:30:00Z, which is AFTER the
    // cutoff even though the local wall-clock date reads as the 8th. A naive
    // string compare ("2026-07-08…" < "2026-07-09…") would wrongly skip it.
    expect(isBeforeSyncCutoff("2026-07-08T20:30:00-04:00", CUTOFF)).toBe(false)
    // And the genuinely-earlier side of the boundary still skips.
    expect(isBeforeSyncCutoff("2026-07-08T19:30:00-04:00", CUTOFF)).toBe(true)
  })

  it("fails OPEN: a null/empty cutoff means no floor (import everything)", () => {
    expect(isBeforeSyncCutoff("2000-01-01T00:00:00Z", null)).toBe(false)
    expect(isBeforeSyncCutoff("2000-01-01T00:00:00Z", undefined)).toBe(false)
    expect(isBeforeSyncCutoff("2000-01-01T00:00:00Z", "")).toBe(false)
  })

  it("fails OPEN: an absent or unparseable createdAt is never dropped", () => {
    expect(isBeforeSyncCutoff(null, CUTOFF)).toBe(false)
    expect(isBeforeSyncCutoff(undefined, CUTOFF)).toBe(false)
    expect(isBeforeSyncCutoff("not-a-date", CUTOFF)).toBe(false)
  })
})

describe("cutoffQueryDate", () => {
  it("returns the UTC date portion for the store fetch filters", () => {
    expect(cutoffQueryDate(CUTOFF)).toBe("2026-07-09")
    expect(cutoffQueryDate("2026-07-09T00:00:00+00:00")).toBe("2026-07-09")
  })

  it("returns null when there is no floor or the value is unparseable", () => {
    expect(cutoffQueryDate(null)).toBeNull()
    expect(cutoffQueryDate(undefined)).toBeNull()
    expect(cutoffQueryDate("nonsense")).toBeNull()
  })
})
