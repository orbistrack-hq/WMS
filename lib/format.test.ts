import { describe, expect, it } from "vitest"

import {
  formatCurrency,
  formatDate,
  formatDateTime,
  todayISODate,
} from "./format"

describe("formatCurrency", () => {
  it("formats a plain number as USD", () => {
    expect(formatCurrency(1234.5)).toBe("$1,234.50")
  })

  it("parses numeric strings", () => {
    expect(formatCurrency("1234.5")).toBe("$1,234.50")
  })

  it("treats null / undefined as zero", () => {
    expect(formatCurrency(null)).toBe("$0.00")
    expect(formatCurrency(undefined)).toBe("$0.00")
  })

  it("falls back to zero for non-numeric strings", () => {
    expect(formatCurrency("abc")).toBe("$0.00")
  })

  it("falls back to zero for non-finite numbers", () => {
    expect(formatCurrency(Number.POSITIVE_INFINITY)).toBe("$0.00")
    expect(formatCurrency(Number.NaN)).toBe("$0.00")
  })

  it("rounds to two decimal places", () => {
    expect(formatCurrency(0.005)).toBe("$0.01")
  })

  it("handles negatives", () => {
    expect(formatCurrency(-42)).toBe("-$42.00")
  })
})

describe("formatDate", () => {
  it("returns an em dash for null / undefined / empty", () => {
    expect(formatDate(null)).toBe("—")
    expect(formatDate(undefined)).toBe("—")
    expect(formatDate("")).toBe("—")
  })

  it("returns an em dash for an unparseable date", () => {
    expect(formatDate("not-a-date")).toBe("—")
  })

  it("renders a valid ISO date with month, day and year", () => {
    // Midday UTC keeps the calendar day stable across CI timezones.
    const out = formatDate("2026-06-23T12:00:00Z")
    expect(out).toContain("2026")
    expect(out).toContain("Jun")
    expect(out).not.toBe("—")
  })
})

describe("formatDateTime", () => {
  it("returns an em dash for null / invalid input", () => {
    expect(formatDateTime(null)).toBe("—")
    expect(formatDateTime("nope")).toBe("—")
  })

  it("includes both the date and a time component", () => {
    const out = formatDateTime("2026-06-23T12:00:00Z")
    expect(out).toContain("2026")
    // A time is present (AM/PM marker from the en-US formatter).
    expect(out).toMatch(/\b(AM|PM)\b/)
  })
})

describe("todayISODate", () => {
  it("returns a YYYY-MM-DD string", () => {
    expect(todayISODate()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it("matches the current UTC date", () => {
    expect(todayISODate()).toBe(new Date().toISOString().slice(0, 10))
  })
})
