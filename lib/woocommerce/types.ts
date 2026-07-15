import crypto from "node:crypto"

// ---------------------------------------------------------------------------
// WooCommerce REST payloads — only the fields the import uses. Woo sends much
// more; we read defensively and ignore the rest.
//
// Channel-specific notes vs. Shopify:
//   * Auth is consumer key + secret (Basic over HTTPS) for REST pulls; webhooks
//     are signed with a SEPARATE per-webhook secret.
//   * Products are "simple" (the product id is the sellable unit) or "variable"
//     (parent id + variation ids, where each variation is the sellable unit).
//   * Woo core has no cost-of-goods field, so cost is never seeded from Woo —
//     WMS keeps owning cost (matches upsert_store_variant's seed-only policy).
// ---------------------------------------------------------------------------

export type WooAddress = {
  first_name?: string | null
  last_name?: string | null
  company?: string | null
  address_1?: string | null
  address_2?: string | null
  city?: string | null
  state?: string | null
  postcode?: string | null
  country?: string | null
  email?: string | null
}

export type WooLineItem = {
  product_id?: number | string | null
  variation_id?: number | string | null
  quantity?: number | null
  // Woo sends `price` as a unit price (number) and `total`/`subtotal` as line
  // strings. We use the per-unit `price`.
  price?: string | number | null
  name?: string | null
  sku?: string | null
}

export type WooOrderPayload = {
  id?: number | string | null
  number?: string | null // human order number, e.g. "1042"
  status?: string | null // pending|processing|on-hold|completed|cancelled|refunded|failed
  date_created?: string | null
  date_completed?: string | null
  customer_id?: number | string | null
  customer_note?: string | null
  billing?: WooAddress | null
  shipping?: WooAddress | null
  line_items?: WooLineItem[] | null
}

/** One entry from a product/variation `meta_data` array (plugin custom fields). */
export type WooMetaData = { key?: string | null; value?: unknown }

// Cost-of-goods meta keys to read, in priority order. WPFactory's "Cost of
// Goods for WooCommerce" uses _alg_wc_cog_cost; the SkyVerge plugin uses
// _wc_cog_cost. Woo core has no cost field, so cost only exists if a plugin
// provides it.
const COST_META_KEYS = ["_alg_wc_cog_cost", "_wc_cog_cost"]

/**
 * Canonical form of a Woo store URL, used as the connection `source` key on
 * both sides (the connect form and the webhook's x-wc-webhook-source header) so
 * lookups match. Lowercased host, scheme preserved, no trailing slash or path.
 */
export function normalizeWooSource(input: string): string {
  const raw = (input ?? "").trim()
  if (!raw) return ""
  try {
    const u = new URL(raw.includes("://") ? raw : `https://${raw}`)
    return `${u.protocol}//${u.host.toLowerCase()}`
  } catch {
    return raw.toLowerCase().replace(/\/+$/, "")
  }
}

export type WooAttribute = { name?: string | null; option?: string | null }

export type WooProduct = {
  id?: number | string | null
  name?: string | null
  sku?: string | null
  type?: string | null // 'simple' | 'variable' | 'grouped' | 'external'
  status?: string | null
  price?: string | number | null
  regular_price?: string | number | null
  manage_stock?: boolean | null
  stock_quantity?: number | null
  meta_data?: WooMetaData[] | null
  // On a variable product the webhook payload carries variation IDs only; full
  // per-variation data must be pulled from /products/{id}/variations.
  variations?: number[] | null
}

export type WooVariation = {
  id?: number | string | null
  sku?: string | null
  status?: string | null
  price?: string | number | null
  regular_price?: string | number | null
  manage_stock?: boolean | null
  stock_quantity?: number | null
  attributes?: WooAttribute[] | null
  meta_data?: WooMetaData[] | null
}

const str = (v: unknown): string | null =>
  v === null || v === undefined || v === "" ? null : String(v)

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * The sellable unit's external id for a Woo order line: the variation id when
 * the line is a product variation, otherwise the (simple) product id. Mirrors
 * how the catalog stores store_variant_id.
 */
export function wooLineVariantId(li: WooLineItem): string | null {
  const variation = num(li.variation_id)
  if (variation && variation > 0) return String(variation)
  return str(li.product_id)
}

/**
 * Pull unit cost from a product/variation `meta_data` array, reading the known
 * Cost-of-Goods plugin keys in priority order. Returns null when no plugin cost
 * is present (Woo core has none) so the catalog keeps WMS-owned cost untouched.
 */
export function wooCost(
  metaData: WooMetaData[] | null | undefined,
): number | null {
  if (!Array.isArray(metaData)) return null
  for (const key of COST_META_KEYS) {
    const hit = metaData.find((m) => m?.key === key)
    if (hit) {
      const c = num(hit.value)
      if (c !== null) return c
    }
  }
  return null
}

/** Build a WMS product name from a Woo variation's attribute options. */
export function wooVariantName(
  productName: string | null | undefined,
  attributes: WooAttribute[] | null | undefined,
): string {
  const base = (productName ?? "").trim() || "Untitled product"
  const opts = (attributes ?? [])
    .map((a) => (a.option ?? "").trim())
    .filter(Boolean)
  return opts.length ? `${base} - ${opts.join(" / ")}` : base
}

/**
 * Verify a WooCommerce webhook signature: base64 of HMAC-SHA256 over the raw
 * request body, keyed by the webhook's secret. Constant-time; false on any
 * malformed input. (Same construction as Shopify, different header/secret.)
 */
export function verifyWooSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string | undefined,
): boolean {
  if (!signatureHeader || !secret) return false
  const digest = crypto
    .createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("base64")
  const a = Buffer.from(digest)
  const b = Buffer.from(signatureHeader)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

/**
 * Where a Woo order sits, reduced to what WMS acts on:
 *  - "fulfilled" → completed; WMS marks it fulfilled (skips pick/pack).
 *  - "cancelled" → cancelled/refunded/failed; WMS cancels it (releases stock).
 *  - "open"      → pending/processing/on-hold; normal pick/pack flow.
 */
export type WooLifecycle = "open" | "fulfilled" | "cancelled"

export function deriveWooLifecycle(status: string | null | undefined): WooLifecycle {
  const s = (status ?? "").toLowerCase()
  if (s === "completed") return "fulfilled"
  if (s === "cancelled" || s === "refunded" || s === "failed") return "cancelled"
  return "open"
}

/**
 * The lifecycle a webhook should actually apply, accounting for its topic.
 *
 * A Woo `order.deleted` (trash/permanent-delete) webhook carries only an id —
 * no `status` — so normalizeWooOrder + deriveWooLifecycle default it to "open"
 * and the reconcile no-ops, leaving the WMS order stuck at `created` with its
 * stock still reserved. But a store-side delete is exactly the signal we
 * subscribe to order.deleted for: it must CANCEL the WMS order (release the
 * reservation). So a delete always resolves to "cancelled"; every other topic
 * uses the status-derived lifecycle unchanged.
 */
export function effectiveWooLifecycle(
  topic: string,
  statusLifecycle: WooLifecycle,
): WooLifecycle {
  if (topic === "order.deleted") return "cancelled"
  return statusLifecycle
}

/**
 * Whether a Woo order's payment has cleared, deciding if an OPEN order enters
 * the pick/pack flow now or is held as pending_payment until paid.
 *
 * Per the team: ONLY fully-paid ships. Woo `processing` and `completed` mean the
 * payment gateway captured funds; `pending` (pending payment) and `on-hold`
 * (awaiting bank transfer / manual review) do not. `failed`/`cancelled`/
 * `refunded` never reach here as "open" — deriveWooLifecycle maps them to
 * cancelled. Unknown/blank status is treated as NOT paid, so it's held rather
 * than shipped on a guess.
 */
export function deriveWooPaid(status: string | null | undefined): boolean {
  const s = (status ?? "").toLowerCase()
  return s === "processing" || s === "completed"
}

export type NormalizedStoreOrder = {
  externalOrderId: string
  number: string | null
  note: string | null
  // Original Woo order time (ISO), used to backdate a backfilled WMS order so it
  // keeps its real sale date instead of "now".
  createdAt: string | null
  lifecycle: WooLifecycle
  // Whether payment has cleared. When lifecycle is "open" and this is false the
  // order is held as pending_payment (reserves no stock) until payment lands.
  paid: boolean
  // Best-effort fulfillment time (date_completed, else date_created); null
  // unless lifecycle is "fulfilled".
  fulfilledAt: string | null
  customer: {
    externalId: string | null
    email: string | null
    name: string | null
  } | null
  shipTo: {
    name: string | null
    address1: string | null
    address2: string | null
    city: string | null
    region: string | null
    postal: string | null
    country: string | null
  } | null
  lines: {
    variantId: string | null
    quantity: number
    unitPrice: number | null
    title: string | null
  }[]
}

const addrName = (a: WooAddress): string | null => {
  const n = [a.first_name, a.last_name].filter(Boolean).join(" ").trim()
  return n || str(a.company)
}

/** Reduce a raw Woo order to the fields the WMS import needs. */
export function normalizeWooOrder(
  payload: WooOrderPayload,
): NormalizedStoreOrder {
  const ship = payload.shipping ?? null
  const bill = payload.billing ?? null
  const hasShip = ship && (ship.address_1 || ship.city || ship.postcode)
  const addr = hasShip ? ship : bill
  const createdAt = str(payload.date_created)
  const lifecycle = deriveWooLifecycle(payload.status)

  return {
    externalOrderId: str(payload.id) ?? "",
    number: str(payload.number),
    note: str(payload.customer_note),
    createdAt,
    lifecycle,
    paid: deriveWooPaid(payload.status),
    fulfilledAt:
      lifecycle === "fulfilled" ? (str(payload.date_completed) ?? createdAt) : null,
    customer: bill
      ? {
          externalId: str(payload.customer_id) === "0" ? null : str(payload.customer_id),
          email: str(bill.email),
          name: addrName(bill),
        }
      : null,
    shipTo: addr
      ? {
          name: addrName(addr),
          address1: str(addr.address_1),
          address2: str(addr.address_2),
          city: str(addr.city),
          region: str(addr.state),
          postal: str(addr.postcode),
          country: str(addr.country),
        }
      : null,
    lines: (payload.line_items ?? [])
      .filter((li) => (li.quantity ?? 0) > 0 && wooLineVariantId(li) != null)
      .map((li) => ({
        variantId: wooLineVariantId(li),
        quantity: Number(li.quantity),
        unitPrice: num(li.price),
        title: str(li.name),
      })),
  }
}
