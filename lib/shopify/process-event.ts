import type { SupabaseClient } from "@supabase/supabase-js"

import {
  normalizeShopifyOrder,
  shopifyInventoryItemCost,
  type ShopifyInventoryItemPayload,
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
  if (topic === "inventory_items/update") {
    return handleInventoryItemCost(
      supabase,
      shopDomain,
      payload as ShopifyInventoryItemPayload,
    )
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

// ---------------------------------------------------------------------------
// Unit cost (InventoryItem)
// ---------------------------------------------------------------------------
/**
 * Apply a cost-only change made in Shopify.
 *
 * Cost lives on the InventoryItem, not the product, so editing ONLY the cost
 * fires `inventory_items/update` and NOT `products/update` — without this handler
 * a cost-only edit never reached WMS until someone ran a manual product sync.
 * (Edits that also touch the product still arrive via handleProductUpsert, which
 * fetches cost from the same InventoryItem.)
 *
 * Maps by child_skus.store_inventory_item_id, which the catalog import already
 * persists for outbound stock pushes (migration 0026), so no extra lookup call to
 * Shopify is needed. Scoped to the connection's site: an inventory item id is
 * only meaningful for the store that owns it.
 *
 * Idempotent by construction — it sets an absolute value rather than applying a
 * delta — and a re-delivery whose cost already matches is reported as no_change
 * so it writes nothing and adds no audit row. The child_skus audit trigger logs
 * the real writes with an old/new snapshot.
 */
async function handleInventoryItemCost(
  supabase: SupabaseClient,
  shopDomain: string,
  payload: ShopifyInventoryItemPayload,
): Promise<ProcessResult> {
  const conn = await connForShop(supabase, shopDomain)
  if (!conn) return { status: "no_connection" }

  const parsed = shopifyInventoryItemCost(payload)
  if (!parsed) {
    // No id, or a null/zero cost — see shopifyInventoryItemCost on why a zero
    // cost is never applied.
    return {
      status: "ignored",
      topic: "inventory_items/update",
      reason: "no positive cost on payload",
    }
  }

  const { data: matches, error: readErr } = await supabase
    .from("child_skus")
    .select("id, cost")
    .eq("site_id", conn.siteId)
    .eq("store_inventory_item_id", parsed.inventoryItemId)
  if (readErr) return { status: "error", error: readErr.message }

  if (!matches || matches.length === 0) {
    // The variant hasn't been imported yet (or predates store_inventory_item_id
    // being recorded). A product sync maps it and picks the cost up then.
    return {
      status: "ignored",
      topic: "inventory_items/update",
      reason: "inventory item not mapped to a child SKU",
      inventoryItemId: parsed.inventoryItemId,
    }
  }

  const stale = matches
    .filter((m) => Number(m.cost) !== parsed.cost)
    .map((m) => m.id as string)
  if (stale.length === 0) {
    return { status: "no_change", cost: parsed.cost, childSkus: 0 }
  }

  const { error: writeErr } = await supabase
    .from("child_skus")
    .update({ cost: parsed.cost })
    .in("id", stale)
  if (writeErr) return { status: "error", error: writeErr.message }

  return { status: "cost_updated", cost: parsed.cost, childSkus: stale.length }
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
