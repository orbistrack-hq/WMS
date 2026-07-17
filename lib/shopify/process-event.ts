import type { SupabaseClient } from "@supabase/supabase-js"

import {
  normalizeShopifyOrder,
  type ShopifyOrderPayload,
  type ShopifyProduct,
} from "./types"
import {
  importShopifyProduct,
  deactivateShopifyProduct,
} from "./import-products"
import { fetchVariantCosts } from "./rest"
import {
  importNormalizedOrder,
  applyShopifyLifecycleUpdate,
} from "./import-orders"

/**
 * Shared Shopify webhook processor. Runs the actual DB work for one event and
 * returns a plain serializable result. Called by BOTH the inline fallback (in
 * the webhook route when no queue is configured) and the QStash worker route,
 * so the sync behaves identically whichever path runs it.
 *
 * Must be given a service-role client: it writes store_order_imports (no RLS
 * write policy) and calls the guarded order RPCs.
 */
export type ProcessResult = {
  status: string
  [k: string]: unknown
}

/** Topics that signal a possible lifecycle change on an existing order. */
const ORDER_UPDATE_TOPICS = new Set([
  "orders/updated",
  "orders/fulfilled",
  "orders/partially_fulfilled",
  "orders/cancelled",
  "orders/paid",
])

export async function processShopifyEvent(
  supabase: SupabaseClient,
  topic: string,
  shopDomain: string,
  payload: unknown,
): Promise<ProcessResult> {
  if (topic === "orders/create") {
    return handleOrderCreate(supabase, shopDomain, topic, payload as ShopifyOrderPayload)
  }
  if (ORDER_UPDATE_TOPICS.has(topic)) {
    return handleOrderUpdate(supabase, shopDomain, topic, payload as ShopifyOrderPayload)
  }
  if (topic === "products/create" || topic === "products/update") {
    return handleProductUpsert(supabase, shopDomain, payload as ShopifyProduct)
  }
  if (topic === "products/delete") {
    return handleProductDelete(supabase, shopDomain, payload as ShopifyProduct)
  }
  if (topic === "inventory_levels/update") {
    // Inbound stock from Shopify is deliberately NOT applied yet: doing so
    // safely requires echo-loop protection (our own outbound stock pushes make
    // Shopify fire this event right back at us, and blindly applying it would
    // fight our own write). Subscribed so deliveries arrive and are visible;
    // wiring the apply is a separate, guarded task.
    return { status: "ignored", topic, reason: "inventory apply not yet wired" }
  }
  return { status: "ignored", topic }
}

/** The active WMS site a store feeds + its order-sync floor, or null if not
 *  connected. cutoff is null when the connection has no floor set. */
async function connForShop(
  supabase: SupabaseClient,
  shopDomain: string,
): Promise<{ siteId: string; cutoff: string | null } | null> {
  const { data } = await supabase
    .from("store_connections")
    .select("site_id, sync_orders_since")
    .eq("channel", "shopify")
    .eq("source", shopDomain)
    .eq("is_active", true)
    .maybeSingle()
  if (!data?.site_id) return null
  return {
    siteId: data.site_id as string,
    cutoff: (data.sync_orders_since as string | null) ?? null,
  }
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------
async function handleOrderCreate(
  supabase: SupabaseClient,
  shopDomain: string,
  topic: string,
  payload: ShopifyOrderPayload,
): Promise<ProcessResult> {
  const conn = await connForShop(supabase, shopDomain)
  if (!conn) return { status: "no_connection" }

  const order = normalizeShopifyOrder(payload)
  const outcome = await importNormalizedOrder(
    supabase,
    conn.siteId,
    shopDomain,
    order,
    topic,
    payload,
    conn.cutoff,
  )
  // If the order already exists (e.g. create re-delivered after an update
  // landed first), make sure its lifecycle is still reconciled.
  if (outcome.status === "duplicate") {
    const life = await applyShopifyLifecycleUpdate(supabase, shopDomain, order)
    return { status: "duplicate", lifecycle: life.status }
  }
  return { ...outcome }
}

async function handleOrderUpdate(
  supabase: SupabaseClient,
  shopDomain: string,
  topic: string,
  payload: ShopifyOrderPayload,
): Promise<ProcessResult> {
  const conn = await connForShop(supabase, shopDomain)
  if (!conn) return { status: "no_connection" }

  const order = normalizeShopifyOrder(payload)
  const life = await applyShopifyLifecycleUpdate(supabase, shopDomain, order)

  // Update arrived for an order we never imported (we missed orders/create, or
  // it predates the connection): treat the update as a create. This makes the
  // pair (create + updated) self-healing — but the cutoff still applies, so an
  // edit to a pre-go-live order does not sneak it in.
  if (life.status === "not_found") {
    const outcome = await importNormalizedOrder(
      supabase,
      conn.siteId,
      shopDomain,
      order,
      topic,
      payload,
      conn.cutoff,
    )
    return { status: "imported_from_update", outcome: outcome.status }
  }
  return { status: "lifecycle", result: life.status, ...("reason" in life ? { reason: life.reason } : {}) }
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------
async function handleProductUpsert(
  supabase: SupabaseClient,
  shopDomain: string,
  product: ShopifyProduct,
): Promise<ProcessResult> {
  const conn = await connForShop(supabase, shopDomain)
  if (!conn) return { status: "no_connection" }

  // Cost/COGS isn't in the product webhook payload — it lives on the Shopify
  // InventoryItem — so the webhook alone lands variants with no cost. Fetch it
  // via the Admin API (the same call the manual sync makes) and pass it in so
  // the RPC can SEED it. Seed-only: the RPC writes cost only when the existing
  // cost is 0/unset and never overwrites a cost already set in WMS. Stock is
  // still left unwired here (inbound stock avoids echo loops). Best-effort: a
  // missing token or a cost-fetch failure must not fail the catalog sync.
  let costByInventoryItemId: Map<string, number> | undefined
  let costSynced = false
  const invItemIds = (product.variants ?? [])
    .map((v) => (v.inventory_item_id != null ? String(v.inventory_item_id) : null))
    .filter((id): id is string => Boolean(id))
  if (invItemIds.length > 0) {
    const token = await shopifyToken(supabase, shopDomain)
    if (token) {
      try {
        const r = await fetchVariantCosts(shopDomain, token, invItemIds)
        if (!r.unavailable) {
          costByInventoryItemId = r.costs
          costSynced = true
        }
      } catch {
        costByInventoryItemId = undefined
      }
    }
  }

  const result = await importShopifyProduct(supabase, conn.siteId, product, {
    costByInventoryItemId,
  })
  return { status: "synced", costSynced, ...result }
}

/**
 * Admin API access token for a connected Shopify store, looked up by shop
 * domain with the service-role client. Null when the store isn't connected or
 * has no token stored. Cost needs the token's read_inventory scope.
 */
async function shopifyToken(
  supabase: SupabaseClient,
  shopDomain: string,
): Promise<string | null> {
  const { data: conn } = await supabase
    .from("store_connections")
    .select("id")
    .eq("channel", "shopify")
    .eq("source", shopDomain)
    .eq("is_active", true)
    .maybeSingle()
  if (!conn?.id) return null

  const { data: secret } = await supabase
    .from("store_secrets")
    .select("access_token")
    .eq("connection_id", conn.id)
    .maybeSingle()
  return (secret?.access_token as string | null) ?? null
}

async function handleProductDelete(
  supabase: SupabaseClient,
  shopDomain: string,
  product: ShopifyProduct,
): Promise<ProcessResult> {
  const conn = await connForShop(supabase, shopDomain)
  if (!conn) return { status: "no_connection" }
  const d = await deactivateShopifyProduct(supabase, conn.siteId, product)
  return { status: "deleted", childSkus: d.childSkus, products: d.products }
}
