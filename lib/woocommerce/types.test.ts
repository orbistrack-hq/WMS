import crypto from "node:crypto"

import { describe, expect, it } from "vitest"

import {
  deriveWooLifecycle,
  deriveWooOnHold,
  deriveWooPaid,
  effectiveWooLifecycle,
  normalizeWooOrder,
  normalizeWooSource,
  verifyWooSignature,
  wooCost,
  wooLineVariantId,
  wooVariantName,
} from "./types"

describe("deriveWooOnHold", () => {
  it("flags on-hold, nothing else", () => {
    expect(deriveWooOnHold("on-hold")).toBe(true)
    expect(deriveWooOnHold("processing")).toBe(false)
    expect(deriveWooOnHold("pending")).toBe(false)
    expect(deriveWooOnHold("completed")).toBe(false)
    expect(deriveWooOnHold(undefined)).toBe(false)
  })
})

describe("deriveWooPaid", () => {
  it("treats processing and completed as ready to ship", () => {
    expect(deriveWooPaid("processing")).toBe(true)
    expect(deriveWooPaid("completed")).toBe(true)
  })

  it("treats on-hold as ready — ShipStation ships it, so WMS must not hide it", () => {
    expect(deriveWooPaid("on-hold")).toBe(true)
  })

  it("holds ONLY pending (pending payment)", () => {
    expect(deriveWooPaid("pending")).toBe(false)
  })

  it("treats unknown/blank status as ready (never hide an order on a guess)", () => {
    expect(deriveWooPaid(undefined)).toBe(true)
    expect(deriveWooPaid("")).toBe(true)
    expect(deriveWooPaid("weird-status")).toBe(true)
  })
})

describe("effectiveWooLifecycle", () => {
  it("cancels on order.deleted even though the payload has no status", () => {
    // A delete webhook is {id} only -> normalizeWooOrder derives "open".
    const derived = deriveWooLifecycle(undefined)
    expect(derived).toBe("open")
    expect(effectiveWooLifecycle("order.deleted", derived)).toBe("cancelled")
  })

  it("passes a cancelled order.updated straight through", () => {
    expect(
      effectiveWooLifecycle("order.updated", deriveWooLifecycle("cancelled")),
    ).toBe("cancelled")
  })

  it("leaves a still-open processing update untouched", () => {
    expect(
      effectiveWooLifecycle("order.updated", deriveWooLifecycle("processing")),
    ).toBe("open")
  })

  it("does not fulfil-cancel a completed update", () => {
    expect(
      effectiveWooLifecycle("order.updated", deriveWooLifecycle("completed")),
    ).toBe("fulfilled")
  })
})

describe("normalizeWooSource", () => {
  it("lowercases the host and preserves the scheme", () => {
    expect(normalizeWooSource("https://Shop.Example.COM")).toBe(
      "https://shop.example.com",
    )
  })

  it("defaults to https when no scheme is given", () => {
    expect(normalizeWooSource("example.com")).toBe("https://example.com")
  })

  it("preserves an explicit http scheme", () => {
    expect(normalizeWooSource("http://example.com")).toBe("http://example.com")
  })

  it("drops any path and trailing slash", () => {
    expect(normalizeWooSource("https://example.com/wp-json/")).toBe(
      "https://example.com",
    )
  })

  it("returns empty string for blank input", () => {
    expect(normalizeWooSource("")).toBe("")
    expect(normalizeWooSource("   ")).toBe("")
  })
})

describe("wooLineVariantId", () => {
  it("prefers a positive variation id", () => {
    expect(wooLineVariantId({ product_id: 10, variation_id: 55 })).toBe("55")
  })

  it("falls back to product id when there is no variation", () => {
    expect(wooLineVariantId({ product_id: 10, variation_id: 0 })).toBe("10")
    expect(wooLineVariantId({ product_id: 10 })).toBe("10")
  })

  it("returns null when neither id is present", () => {
    expect(wooLineVariantId({})).toBeNull()
  })
})

describe("wooCost", () => {
  it("reads the WPFactory key first", () => {
    expect(
      wooCost([
        { key: "_wc_cog_cost", value: "2.00" },
        { key: "_alg_wc_cog_cost", value: "3.50" },
      ]),
    ).toBe(3.5)
  })

  it("falls back to the SkyVerge key", () => {
    expect(wooCost([{ key: "_wc_cog_cost", value: "2.25" }])).toBe(2.25)
  })

  it("returns null when no cost meta is present", () => {
    expect(wooCost([{ key: "some_other", value: "9" }])).toBeNull()
    expect(wooCost(null)).toBeNull()
    expect(wooCost(undefined)).toBeNull()
  })

  it("returns null when the cost value is non-numeric", () => {
    expect(wooCost([{ key: "_alg_wc_cog_cost", value: "" }])).toBeNull()
  })
})

describe("wooVariantName", () => {
  it("joins attribute options onto the product name", () => {
    expect(
      wooVariantName("Blue Dream", [
        { name: "Weight", option: "3.5g" },
        { name: "Grade", option: "AAA" },
      ]),
    ).toBe("Blue Dream - 3.5g / AAA")
  })

  it("returns the base name when there are no options", () => {
    expect(wooVariantName("Blue Dream", [])).toBe("Blue Dream")
    expect(wooVariantName("Blue Dream", null)).toBe("Blue Dream")
  })

  it("falls back to a placeholder for a blank product name", () => {
    expect(wooVariantName("", [])).toBe("Untitled product")
  })
})

describe("deriveWooLifecycle", () => {
  it("maps completed to fulfilled", () => {
    expect(deriveWooLifecycle("completed")).toBe("fulfilled")
  })

  it("maps cancelled / refunded / failed to cancelled", () => {
    expect(deriveWooLifecycle("cancelled")).toBe("cancelled")
    expect(deriveWooLifecycle("refunded")).toBe("cancelled")
    expect(deriveWooLifecycle("failed")).toBe("cancelled")
  })

  it("treats pending / processing / on-hold / unknown as open", () => {
    expect(deriveWooLifecycle("pending")).toBe("open")
    expect(deriveWooLifecycle("processing")).toBe("open")
    expect(deriveWooLifecycle("on-hold")).toBe("open")
    expect(deriveWooLifecycle(null)).toBe("open")
  })
})

describe("normalizeWooOrder", () => {
  const base = {
    id: 1042,
    number: "1042",
    status: "processing",
    date_created: "2026-06-20T10:00:00",
    customer_id: 7,
    customer_note: "leave at door",
    billing: {
      first_name: "Ada",
      last_name: "Lovelace",
      email: "ada@example.com",
    },
    shipping: {
      first_name: "Ada",
      last_name: "Lovelace",
      address_1: "1 Analytical Way",
      city: "London",
      state: "LDN",
      postcode: "EC1",
      country: "GB",
    },
    line_items: [
      { product_id: 5, variation_id: 9, quantity: 2, price: "12.50", name: "Item A" },
      { product_id: 6, quantity: 1, price: 8, name: "Item B" },
    ],
  }

  it("maps core fields and an open lifecycle", () => {
    const o = normalizeWooOrder(base)
    expect(o.externalOrderId).toBe("1042")
    expect(o.number).toBe("1042")
    expect(o.note).toBe("leave at door")
    expect(o.lifecycle).toBe("open")
    expect(o.fulfilledAt).toBeNull()
  })

  it("prefers the shipping address, falling back to billing", () => {
    const shipped = normalizeWooOrder(base)
    expect(shipped.shipTo?.city).toBe("London")

    const billingOnly = normalizeWooOrder({ ...base, shipping: null })
    expect(billingOnly.shipTo?.name).toBe("Ada Lovelace")
    expect(billingOnly.shipTo?.city).toBeNull()
  })

  it("keeps only line items with a quantity and a resolvable variant id", () => {
    const o = normalizeWooOrder(base)
    expect(o.lines).toHaveLength(2)
    expect(o.lines[0]).toMatchObject({
      variantId: "9",
      quantity: 2,
      unitPrice: 12.5,
      title: "Item A",
    })
    expect(o.lines[1].variantId).toBe("6")
  })

  it("drops zero-quantity lines", () => {
    const o = normalizeWooOrder({
      ...base,
      line_items: [{ product_id: 6, quantity: 0, price: 8 }],
    })
    expect(o.lines).toHaveLength(0)
  })

  it("sets fulfilledAt from date_completed when completed", () => {
    const o = normalizeWooOrder({
      ...base,
      status: "completed",
      date_completed: "2026-06-21T09:00:00",
    })
    expect(o.lifecycle).toBe("fulfilled")
    expect(o.fulfilledAt).toBe("2026-06-21T09:00:00")
  })

  it("nulls the customer external id when it is guest (0)", () => {
    const o = normalizeWooOrder({ ...base, customer_id: 0 })
    expect(o.customer?.externalId).toBeNull()
  })
})

describe("verifyWooSignature", () => {
  const secret = "shhh"
  const body = '{"id":1}'
  const goodSig = crypto
    .createHmac("sha256", secret)
    .update(body, "utf8")
    .digest("base64")

  it("accepts a correct signature", () => {
    expect(verifyWooSignature(body, goodSig, secret)).toBe(true)
  })

  it("rejects a tampered body", () => {
    expect(verifyWooSignature('{"id":2}', goodSig, secret)).toBe(false)
  })

  it("rejects missing header or secret", () => {
    expect(verifyWooSignature(body, null, secret)).toBe(false)
    expect(verifyWooSignature(body, goodSig, undefined)).toBe(false)
  })
})
