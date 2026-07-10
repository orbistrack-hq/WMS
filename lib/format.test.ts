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

  it("renders in the app's Pacific zone regardless of host TZ", () => {
    // 2026-06-23T05:00:00Z is 22:00 on Jun 22 in PDT — the date must roll back.
    expect(formatDate("2026-06-23T05:00:00Z")).toContain("Jun 22")
  })

  it("renders a date-only value as its own calendar day (no TZ shift)", () => {
    // A `date` column like sale_date has no time/zone; it must NOT roll back a
    // day when the app zone is Pacific.
    expect(formatDate("2026-07-09")).toBe("Jul 9, 2026")
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

  it("renders the time in Pacific, not UTC", () => {
    // Noon UTC is 05:00 AM in PDT.
    expect(formatDateTime("2026-06-23T12:00:00Z")).toContain("5:00 AM")
  })
})

describe("todayISODate", () => {
  it("returns a YYYY-MM-DD string", () => {
    expect(todayISODate()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it("matches the current date in the app's Pacific zone", () => {
    const expected = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Los_Angeles",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date())
    expect(todayISODate()).toBe(expected)
  })
})
