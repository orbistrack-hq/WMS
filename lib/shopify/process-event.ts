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

/** The active WMS site a store feeds, or null if not connected. */
async function siteForShop(
  supabase: SupabaseClient,
  shopDomain: string,
): Promise<string | null> {
  const { data } = await supabase
    .from("store_connections")
    .select("site_id")
    .eq("channel", "shopify")
    .eq("source", shopDomain)
    .eq("is_active", true)
    .maybeSingle()
  return (data?.site_id as string) ?? null
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
  const siteId = await siteForShop(supabase, shopDomain)
  if (!siteId) return { status: "no_connection" }

  const order = normalizeShopifyOrder(payload)
  const outcome = await importNormalizedOrder(
    supabase,
    siteId,
    shopDomain,
    order,
    topic,
    payload,
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
  const siteId = await siteForShop(supabase, shopDomain)
  if (!siteId) return { status: "no_connection" }

  const order = normalizeShopifyOrder(payload)
  const life = await applyShopifyLifecycleUpdate(supabase, shopDomain, order)

  // Update arrived for an order we never imported (we missed orders/create, or
  // it predates the connection): treat the update as a create. This makes the
  // pair (create + updated) self-healing.
  if (life.status === "not_found") {
    const outcome = await importNormalizedOrder(
      supabase,
      siteId,
      shopDomain,
      order,
      topic,
      payload,
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
  const siteId = await siteForShop(supabase, shopDomain)
  if (!siteId) return { status: "no_connection" }
  const result = await importShopifyProduct(supabase, siteId, product)
  return { status: "synced", ...result }
}

async function handleProductDelete(
  supabase: SupabaseClient,
  shopDomain: string,
  product: ShopifyProduct,
): Promise<ProcessResult> {
  const siteId = await siteForShop(supabase, shopDomain)
  if (!siteId) return { status: "no_connection" }
  const deactivated = await deactivateShopifyProduct(supabase, siteId, product)
  return { status: "deleted", deactivated }
}
