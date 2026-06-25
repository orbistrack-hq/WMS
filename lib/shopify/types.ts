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
  customer?: ShopifyCustomer | null
  shipping_address?: ShopifyAddress | null
  line_items?: ShopifyLineItem[] | null
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

  return {
    shopifyOrderId: str(payload.id) ?? "",
    name: str(payload.name),
    email: str(payload.email),
    note: str(payload.note),
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
