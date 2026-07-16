import crypto from "node:crypto"

import { describe, expect, it } from "vitest"

import {
  deriveShopifyPaid,
  normalizeShopifyOrder,
  variantProductName,
  verifyShopifyHmac,
} from "./types"

describe("deriveShopifyPaid", () => {
  it("treats paid, partially_refunded and authorized as ready to ship", () => {
    expect(deriveShopifyPaid("paid")).toBe(true)
    expect(deriveShopifyPaid("partially_refunded")).toBe(true)
    expect(deriveShopifyPaid("authorized")).toBe(true) // ShipStation lists these
    expect(deriveShopifyPaid("PAID")).toBe(true) // GraphQL SCREAMING_CASE
    expect(deriveShopifyPaid("AUTHORIZED")).toBe(true)
  })

  it("holds pending, partially_paid and voided", () => {
    expect(deriveShopifyPaid("pending")).toBe(false)
    expect(deriveShopifyPaid("partially_paid")).toBe(false)
    expect(deriveShopifyPaid("voided")).toBe(false)
  })

  it("treats a MISSING status as paid (real webhooks always send it)", () => {
    expect(deriveShopifyPaid(undefined)).toBe(true)
    expect(deriveShopifyPaid(null)).toBe(true)
    expect(deriveShopifyPaid("")).toBe(true)
  })
})

describe("variantProductName", () => {
  it("appends a real variant title", () => {
    expect(variantProductName("Blue Dream", "3.5g")).toBe("Blue Dream - 3.5g")
  })

  it("uses the product title alone for the default variant", () => {
    expect(variantProductName("Blue Dream", "Default Title")).toBe("Blue Dream")
    expect(variantProductName("Blue Dream", "")).toBe("Blue Dream")
    expect(variantProductName("Blue Dream", null)).toBe("Blue Dream")
  })

  it("falls back to a placeholder for a blank product title", () => {
    expect(variantProductName("", "3.5g")).toBe("Untitled product - 3.5g")
  })
})

describe("verifyShopifyHmac", () => {
  const secret = "topsecret"
  const body = '{"id":1001}'
  const goodHmac = crypto
    .createHmac("sha256", secret)
    .update(body, "utf8")
    .digest("base64")

  it("accepts a valid HMAC", () => {
    expect(verifyShopifyHmac(body, goodHmac, secret)).toBe(true)
  })

  it("rejects a tampered body", () => {
    expect(verifyShopifyHmac('{"id":9999}', goodHmac, secret)).toBe(false)
  })

  it("rejects missing header or secret", () => {
    expect(verifyShopifyHmac(body, null, secret)).toBe(false)
    expect(verifyShopifyHmac(body, goodHmac, undefined)).toBe(false)
  })
})

describe("normalizeShopifyOrder", () => {
  const base = {
    id: 5500,
    name: "#1001",
    email: "buyer@example.com",
    created_at: "2026-06-20T10:00:00Z",
    note: "gift wrap",
    customer: {
      id: 42,
      email: "buyer@example.com",
      first_name: "Grace",
      last_name: "Hopper",
    },
    shipping_address: {
      name: "Grace Hopper",
      address1: "1 Compiler Rd",
      city: "Arlington",
      province: "Virginia",
      province_code: "VA",
      zip: "22201",
      country: "United States",
      country_code: "US",
    },
    line_items: [
      { variant_id: 900, quantity: 3, price: "19.99", title: "Widget" },
      { variant_id: null, quantity: 1, price: "5.00", title: "Orphan" },
      { variant_id: 901, quantity: 0, price: "1.00", title: "Zero qty" },
    ],
  }

  it("maps identifiers and an open lifecycle by default", () => {
    const o = normalizeShopifyOrder(base)
    expect(o.shopifyOrderId).toBe("5500")
    expect(o.name).toBe("#1001")
    expect(o.lifecycle).toBe("open")
    expect(o.fulfilledAt).toBeNull()
  })

  it("marks fully fulfilled orders as fulfilled", () => {
    const o = normalizeShopifyOrder({ ...base, fulfillment_status: "fulfilled" })
    expect(o.lifecycle).toBe("fulfilled")
    expect(o.fulfilledAt).toBe("2026-06-20T10:00:00Z")
  })

  it("keeps partially fulfilled orders open", () => {
    const o = normalizeShopifyOrder({ ...base, fulfillment_status: "partial" })
    expect(o.lifecycle).toBe("open")
  })

  it("treats a closed order as fulfilled and backdates to closed_at", () => {
    const o = normalizeShopifyOrder({
      ...base,
      closed_at: "2026-06-22T08:00:00Z",
    })
    expect(o.lifecycle).toBe("fulfilled")
    expect(o.fulfilledAt).toBe("2026-06-22T08:00:00Z")
  })

  it("treats a cancelled order as cancelled", () => {
    const o = normalizeShopifyOrder({
      ...base,
      cancelled_at: "2026-06-21T00:00:00Z",
      fulfillment_status: "fulfilled",
    })
    expect(o.lifecycle).toBe("cancelled")
  })

  it("prefers province, falling back to province_code", () => {
    expect(normalizeShopifyOrder(base).shipTo?.region).toBe("Virginia")
    const noProvince = normalizeShopifyOrder({
      ...base,
      shipping_address: { ...base.shipping_address, province: null },
    })
    expect(noProvince.shipTo?.region).toBe("VA")
  })

  it("keeps only line items with a variant id and positive quantity", () => {
    const o = normalizeShopifyOrder(base)
    expect(o.lines).toHaveLength(1)
    expect(o.lines[0]).toMatchObject({
      variantId: "900",
      quantity: 3,
      unitPrice: 19.99,
      title: "Widget",
    })
  })

  it("returns null customer / shipTo when absent", () => {
    const o = normalizeShopifyOrder({
      ...base,
      customer: null,
      shipping_address: null,
    })
    expect(o.customer).toBeNull()
    expect(o.shipTo).toBeNull()
  })
})
