import crypto from "node:crypto"

import { describe, expect, it } from "vitest"

import { normalizeShopifyOrder, verifyShopifyHmac } from "../shopify/types"
import { normalizeWooOrder, verifyWooSignature } from "../woocommerce/types"
import { dedupeKey, type StoreEventJob } from "./queue"

/**
 * Webhook contract tests (GO-LIVE §7).
 *
 * Replays recorded Shopify / Woo webhook payloads and asserts the two
 * properties the receiver routes rely on for money-safe delivery:
 *
 *   1. AUTHENTICATION — a delivery only proceeds when its HMAC/signature
 *      matches the raw body under the store secret; any tamper -> reject (401).
 *   2. IDEMPOTENCY — the fast-path dedupe key is stable across identical
 *      re-deliveries (so a retried webhook collapses instead of double-counting
 *      stock), and distinct events produce distinct keys (so a genuine update is
 *      never wrongly swallowed).
 *
 * These lock the receiver's guarantees without a database. The durable
 * DB-level idempotency (store_order_imports unique key + guarded RPCs) is
 * covered by the pgTAP suite that runs in CI.
 */

// --- Recorded fixtures (trimmed to the fields the import reads) -------------

const SHOPIFY_ORDER_RAW = JSON.stringify({
  id: 5583470493847,
  name: "#1001",
  email: "buyer@example.com",
  created_at: "2026-06-30T10:15:00-04:00",
  fulfillment_status: null,
  cancelled_at: null,
  closed_at: null,
  customer: { id: 6120, first_name: "Dana", last_name: "Reeves", email: "buyer@example.com" },
  shipping_address: {
    name: "Dana Reeves",
    address1: "22 Wharf St",
    city: "Portland",
    province: "Maine",
    zip: "04101",
    country: "United States",
  },
  line_items: [
    { variant_id: 44012, quantity: 2, price: "18.00", title: "Blue Dream - 3.5g" },
    { variant_id: 44013, quantity: 1, price: "60.00", title: "Blue Dream - 14g" },
  ],
})

const WOO_ORDER_RAW = JSON.stringify({
  id: 1042,
  number: "1042",
  status: "processing",
  date_created: "2026-06-30T14:02:11",
  customer_id: 88,
  billing: { first_name: "Sam", last_name: "Ito", email: "sam@example.com" },
  shipping: { first_name: "Sam", last_name: "Ito", address_1: "5 Kiln Rd", city: "Leeds", postcode: "LS1 4DL", country: "GB" },
  line_items: [
    { product_id: 300, variation_id: 351, quantity: 3, price: "12.50", name: "House Blend - 250g" },
  ],
})

const hmacBase64 = (raw: string, secret: string) =>
  crypto.createHmac("sha256", secret).update(raw, "utf8").digest("base64")

// Woo retries get a fresh delivery id, so the route keys on a hash of the raw
// body instead. Mirror that construction exactly.
const wooBodyHash = (raw: string) =>
  crypto.createHash("sha256").update(raw).digest("hex").slice(0, 32)

// ---------------------------------------------------------------------------
describe("Shopify webhook contract", () => {
  const secret = "shpss_recorded_secret"

  it("authenticates the recorded delivery and rejects any tamper", () => {
    const good = hmacBase64(SHOPIFY_ORDER_RAW, secret)
    expect(verifyShopifyHmac(SHOPIFY_ORDER_RAW, good, secret)).toBe(true)

    // Tampered body (qty 2 -> 20) must fail even with the original signature.
    const tampered = SHOPIFY_ORDER_RAW.replace('"quantity":2', '"quantity":20')
    expect(verifyShopifyHmac(tampered, good, secret)).toBe(false)
    // Wrong secret and missing header also fail closed.
    expect(verifyShopifyHmac(SHOPIFY_ORDER_RAW, good, "wrong")).toBe(false)
    expect(verifyShopifyHmac(SHOPIFY_ORDER_RAW, null, secret)).toBe(false)
  })

  it("normalizes deterministically on replay (same units every time)", () => {
    const payload = JSON.parse(SHOPIFY_ORDER_RAW)
    const first = normalizeShopifyOrder(payload)
    const second = normalizeShopifyOrder(JSON.parse(SHOPIFY_ORDER_RAW))
    expect(second).toEqual(first)
    // The exact unit counts that get reserved — the money-critical numbers.
    expect(first.lines.map((l) => [l.variantId, l.quantity])).toEqual([
      ["44012", 2],
      ["44013", 1],
    ])
    expect(first.lifecycle).toBe("open")
  })

  it("collapses a re-delivery: same webhook id -> same dedupe key", () => {
    const job = (): StoreEventJob => ({
      channel: "shopify",
      source: "acme.myshopify.com",
      topic: "orders/create",
      webhookId: "d8f1-webhook-id",
      payload: JSON.parse(SHOPIFY_ORDER_RAW),
    })
    expect(dedupeKey(job())).toBe(dedupeKey(job()))
  })

  it("does not collapse two different orders", () => {
    const base = {
      channel: "shopify" as const,
      source: "acme.myshopify.com",
      topic: "orders/create",
    }
    expect(dedupeKey({ ...base, webhookId: "wh-A" })).not.toBe(
      dedupeKey({ ...base, webhookId: "wh-B" }),
    )
  })
})

// ---------------------------------------------------------------------------
describe("WooCommerce webhook contract", () => {
  const secret = "wc_recorded_secret"

  it("authenticates the recorded delivery and rejects any tamper", () => {
    const good = hmacBase64(WOO_ORDER_RAW, secret)
    expect(verifyWooSignature(WOO_ORDER_RAW, good, secret)).toBe(true)

    const tampered = WOO_ORDER_RAW.replace('"quantity":3', '"quantity":30')
    expect(verifyWooSignature(tampered, good, secret)).toBe(false)
    expect(verifyWooSignature(WOO_ORDER_RAW, good, "wrong")).toBe(false)
    expect(verifyWooSignature(WOO_ORDER_RAW, null, secret)).toBe(false)
  })

  it("normalizes deterministically on replay (variation id is the unit)", () => {
    const payload = JSON.parse(WOO_ORDER_RAW)
    const first = normalizeWooOrder(payload)
    const second = normalizeWooOrder(JSON.parse(WOO_ORDER_RAW))
    expect(second).toEqual(first)
    // Variation id wins over product id; qty is the reserved count.
    expect(first.lines.map((l) => [l.variantId, l.quantity])).toEqual([["351", 3]])
    expect(first.lifecycle).toBe("open")
  })

  it("collapses a retry keyed on the body hash (Woo re-issues delivery ids)", () => {
    // Two deliveries of the SAME body — Woo gives each a new delivery id, but the
    // route keys on the body hash, so they must dedupe to one key.
    const jobFor = (raw: string): StoreEventJob => ({
      channel: "woocommerce",
      source: "https://shop.example.com",
      topic: "order.updated",
      webhookId: wooBodyHash(raw),
      payload: JSON.parse(raw),
    })
    expect(dedupeKey(jobFor(WOO_ORDER_RAW))).toBe(dedupeKey(jobFor(WOO_ORDER_RAW)))

    // A genuinely different update (status -> completed) hashes differently and
    // is therefore processed, not swallowed.
    const changed = WOO_ORDER_RAW.replace('"status":"processing"', '"status":"completed"')
    expect(dedupeKey(jobFor(changed))).not.toBe(dedupeKey(jobFor(WOO_ORDER_RAW)))
  })
})
