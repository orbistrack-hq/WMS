import crypto from "node:crypto"

// ---------------------------------------------------------------------------
// Shopify Admin API order payload — only the fields the import uses. Shopify
// sends much more; we read defensively and ignore the rest.
// ---------------------------------------------------------------------------
export type ShopifyAddress = {
  name?: string | null
  address1?: string | null
  address2?: string | null
  city?: string | null
  province?: string | null
  province_code?: string | null
  zip?: string | null
  country?: string | null
  country_code?: string | null
}

export type ShopifyLineItem = {
  variant_id?: number | string | null
  quantity?: number | null
  price?: string | number | null
  title?: string | null
}

export type ShopifyCustomer = {
  id?: number | string | null
  email?: string | null
  first_name?: string | null
  last_name?: string | null
}

export type ShopifyVariant = {
  id?: number | string | null
  title?: string | null
  sku?: string | null
  price?: string | number | null
  // Links the variant to its InventoryItem (where cost lives) and the legacy
  // total-available count. Both require the read_inventory scope; when the
  // token lacks it, Shopify returns them as null and we simply skip those facts.
  inventory_item_id?: number | string | null
  inventory_quantity?: number | null
}

// One InventoryItem from /admin/api/.../inventory_items.json — only the cost.
export type ShopifyInventoryItem = {
  id?: number | string | null
  cost?: string | number | null
}

export type ShopifyProduct = {
  id?: number | string | null
  title?: string | null
  status?: string | null
  variants?: ShopifyVariant[] | null
}

/**
 * WMS has no variant tier, so a multi-variant Shopify product becomes several
 * WMS products. Name them "product - variant" unless it's the lone default
 * variant, in which case the product title stands alone.
 */
export function variantProductName(
  productTitle: string | null | undefined,
  variantTitle: string | null | undefined,
): string {
  const base = (productTitle ?? "").trim() || "Untitled product"
  const v = (variantTitle ?? "").trim()
  if (!v || v.toLowerCase() === "default title") return base
  return `${base} - ${v}`
}

export type ShopifyOrderPayload = {
  id?: number | string | null
  name?: string | null // e.g. "#1001"
  email?: string | null
  created_at?: string | null
  note?: string | null
  total_tax?: string | number | null
  current_total_discounts?: string | number | null
  // Lifecycle signals. fulfillment_status is "fulfilled" | "partial" | null;
  // closed_at marks an archived/completed order; cancelled_at a cancelled one.
  fulfillment_status?: string | null
  closed_at?: string | null
  cancelled_at?: string | null
  // Payment signal: "pending" | "authorized" | "partially_paid" | "paid" |
  // "partially_refunded" | "refunded" | "voided". Decides hold vs ship.
  financial_status?: string | null
  customer?: ShopifyCustomer | null
  shipping_address?: ShopifyAddress | null
  line_items?: ShopifyLineItem[] | null
}

/**
 * Where a Shopify order sits in its lifecycle, reduced to what WMS acts on:
 *  - "fulfilled"  → fully fulfilled or archived/closed; WMS marks it fulfilled
 *                   directly, skipping pick/pack.
 *  - "cancelled"  → cancelled in Shopify; WMS cancels it (releases stock).
 *  - "open"       → still to fulfil (incl. PARTIALLY fulfilled); normal flow.
 */
export type ShopifyLifecycle = "open" | "fulfilled" | "cancelled"

/**
 * Map raw Shopify signals to a WMS lifecycle. Partial fulfilment deliberately
 * stays "open" so the outstanding units keep flowing through pick/pack.
 */
function deriveLifecycle(opts: {
  cancelledAt: string | null
  closedAt: string | null
  /** REST fulfillment_status ("fulfilled"/"partial") or GraphQL display status. */
  fulfillmentStatus: string | null
  /** GraphQL `closed` boolean, when present. */
  closed?: boolean | null
}): ShopifyLifecycle {
  if (opts.cancelledAt) return "cancelled"
  const fs = (opts.fulfillmentStatus ?? "").toUpperCase()
  const fullyFulfilled = fs === "FULFILLED"
  if (fullyFulfilled || opts.closedAt || opts.closed === true) return "fulfilled"
  return "open"
}

/**
 * Whether a Shopify order's payment has cleared, deciding if an OPEN order
 * enters the pick/pack flow now or is held as pending_payment until paid.
 *
 * Tracks what ShipStation ships (so OT's packing screen matches it). `paid`,
 * `partially_refunded` (was fully paid, partially returned), and `authorized`
 * (funds authorized, captured at fulfilment — ShipStation lists these as
 * awaiting shipment) count as READY. `pending`, `partially_paid`, and `voided`
 * do NOT — they hold as pending_payment and auto-promote when the order is
 * paid. Accepts REST snake_case and GraphQL SCREAMING_CASE. A missing status is
 * treated as ready so a payload without the field doesn't silently hold every
 * order (Shopify always sends it on real order webhooks).
 */
export function deriveShopifyPaid(
  financialStatus: string | null | undefined,
): boolean {
  const s = (financialStatus ?? "").toLowerCase()
  if (s === "") return true
  return s === "paid" || s === "partially_refunded" || s === "authorized"
}

/**
 * Verify a Shopify webhook HMAC (base64 of HMAC-SHA256 over the raw body).
 * Constant-time comparison; returns false on any malformed input.
 */
export function verifyShopifyHmac(
  rawBody: string,
  hmacHeader: string | null,
  secret: string | undefined,
): boolean {
  if (!hmacHeader || !secret) return false
  const digest = crypto
    .createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("base64")
  const a = Buffer.from(digest)
  const b = Buffer.from(hmacHeader)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

export type NormalizedShopifyOrder = {
  shopifyOrderId: string
  name: string | null
  email: string | null
  note: string | null
  // Original Shopify order creation time (ISO). Used to backdate the WMS order
  // so a backfilled order keeps its real sale date instead of "now".
  createdAt: string | null
  // Lifecycle the WMS order should land in (see ShopifyLifecycle).
  lifecycle: ShopifyLifecycle
  // Whether payment has cleared. When lifecycle is "open" and this is false the
  // order is held as pending_payment (reserves no stock) until payment lands.
  paid: boolean
  // Why it's held, for the display label only. Shopify holds are always
  // "pending" (authorized is treated as ready). Null unless held.
  holdReason: "pending" | "on_hold" | null
  // Best-effort fulfillment timestamp (closed_at, else created_at) used to
  // backdate fulfill_order; null unless `lifecycle` is "fulfilled".
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

const str = (v: unknown): string | null =>
  v === null || v === undefined || v === "" ? null : String(v)

const fullName = (c: ShopifyCustomer): string | null => {
  const n = [c.first_name, c.last_name].filter(Boolean).join(" ").trim()
  return n || null
}

/** Reduce a raw Shopify order to the fields the WMS import needs. */
export function normalizeShopifyOrder(
  payload: ShopifyOrderPayload,
): NormalizedShopifyOrder {
  const addr = payload.shipping_address ?? null
  const cust = payload.customer ?? null
  const createdAt = str(payload.created_at)
  const closedAt = str(payload.closed_at)
  const lifecycle = deriveLifecycle({
    cancelledAt: str(payload.cancelled_at),
    closedAt,
    fulfillmentStatus: str(payload.fulfillment_status),
  })

  return {
    shopifyOrderId: str(payload.id) ?? "",
    name: str(payload.name),
    email: str(payload.email),
    note: str(payload.note),
    createdAt,
    lifecycle,
    paid: deriveShopifyPaid(payload.financial_status),
    holdReason:
      lifecycle === "open" && !deriveShopifyPaid(payload.financial_status)
        ? "pending"
        : null,
    fulfilledAt: lifecycle === "fulfilled" ? (closedAt ?? createdAt) : null,
    customer: cust
      ? {
          externalId: str(cust.id),
          email: str(cust.email) ?? str(payload.email),
          name: fullName(cust),
        }
      : null,
    shipTo: addr
      ? {
          name: str(addr.name),
          address1: str(addr.address1),
          address2: str(addr.address2),
          city: str(addr.city),
          region: str(addr.province) ?? str(addr.province_code),
          postal: str(addr.zip),
          country: str(addr.country) ?? str(addr.country_code),
        }
      : null,
    lines: (payload.line_items ?? [])
      .filter((li) => li.variant_id != null && (li.quantity ?? 0) > 0)
      .map((li) => ({
        variantId: str(li.variant_id),
        quantity: Number(li.quantity),
        unitPrice: li.price != null ? Number(li.price) : null,
        title: str(li.title),
      })),
  }
}

// ---------------------------------------------------------------------------
// Shopify GraphQL Admin API order shape — only the fields the backfill reads.
// The orders REST endpoint is on Shopify's deprecation path, so historical
// order pulls go through GraphQL. GraphQL returns global IDs (GIDs) like
// "gid://shopify/ProductVariant/123"; gidId() strips them back to the bare
// numeric id we store in child_skus.store_variant_id.
// ---------------------------------------------------------------------------
export type ShopifyMoney = { amount?: string | number | null } | null

export type ShopifyGraphqlLineItem = {
  quantity?: number | null
  title?: string | null
  variant?: { id?: string | null } | null
  originalUnitPriceSet?: { shopMoney?: ShopifyMoney } | null
}

export type ShopifyGraphqlOrder = {
  id?: string | null // gid://shopify/Order/123
  name?: string | null
  email?: string | null
  note?: string | null
  createdAt?: string | null
  // Lifecycle signals (GraphQL spellings).
  displayFulfillmentStatus?: string | null // FULFILLED | PARTIALLY_FULFILLED | ...
  displayFinancialStatus?: string | null // PAID | PENDING | AUTHORIZED | ...
  closed?: boolean | null
  closedAt?: string | null
  cancelledAt?: string | null
  customer?: {
    id?: string | null
    email?: string | null
    firstName?: string | null
    lastName?: string | null
  } | null
  shippingAddress?: {
    name?: string | null
    address1?: string | null
    address2?: string | null
    city?: string | null
    province?: string | null
    provinceCode?: string | null
    zip?: string | null
    country?: string | null
    countryCode?: string | null
  } | null
  lineItems?: { nodes?: ShopifyGraphqlLineItem[] | null } | null
}

export type ShopifyGraphqlOrdersPage = {
  pageInfo: { hasNextPage: boolean; endCursor: string | null }
  nodes: ShopifyGraphqlOrder[]
}

/** Extract the trailing numeric id from a Shopify GID, e.g.
 *  "gid://shopify/ProductVariant/123" -> "123". Returns null when absent. */
export function gidId(gid: string | null | undefined): string | null {
  if (!gid) return null
  const m = String(gid).match(/(\d+)(?:\?.*)?$/)
  return m ? m[1] : null
}

/** Reduce a GraphQL order node to the same shape the REST import uses, so both
 *  the webhook and the backfill feed identical data into the order importer. */
export function normalizeGraphqlOrder(
  node: ShopifyGraphqlOrder,
): NormalizedShopifyOrder {
  const addr = node.shippingAddress ?? null
  const cust = node.customer ?? null
  const custName = cust
    ? [cust.firstName, cust.lastName].filter(Boolean).join(" ").trim() || null
    : null
  const createdAt = str(node.createdAt)
  const closedAt = str(node.closedAt)
  const lifecycle = deriveLifecycle({
    cancelledAt: str(node.cancelledAt),
    closedAt,
    fulfillmentStatus: str(node.displayFulfillmentStatus),
    closed: node.closed ?? null,
  })

  return {
    shopifyOrderId: gidId(node.id) ?? "",
    name: str(node.name),
    email: str(node.email),
    note: str(node.note),
    createdAt,
    lifecycle,
    paid: deriveShopifyPaid(node.displayFinancialStatus),
    holdReason:
      lifecycle === "open" && !deriveShopifyPaid(node.displayFinancialStatus)
        ? "pending"
        : null,
    fulfilledAt: lifecycle === "fulfilled" ? (closedAt ?? createdAt) : null,
    customer: cust
      ? {
          externalId: gidId(cust.id),
          email: str(cust.email) ?? str(node.email),
          name: custName,
        }
      : null,
    shipTo: addr
      ? {
          name: str(addr.name),
          address1: str(addr.address1),
          address2: str(addr.address2),
          city: str(addr.city),
          region: str(addr.province) ?? str(addr.provinceCode),
          postal: str(addr.zip),
          country: str(addr.country) ?? str(addr.countryCode),
        }
      : null,
    lines: (node.lineItems?.nodes ?? [])
      .filter((li) => li.variant?.id != null && (li.quantity ?? 0) > 0)
      .map((li) => {
        const amount = li.originalUnitPriceSet?.shopMoney?.amount
        return {
          variantId: gidId(li.variant?.id),
          quantity: Number(li.quantity),
          unitPrice: amount != null ? Number(amount) : null,
          title: str(li.title),
        }
      }),
  }
}
