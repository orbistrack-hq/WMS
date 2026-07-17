import type { SupabaseClient } from "@supabase/supabase-js"

import {
  effectiveWooLifecycle,
  normalizeWooOrder,
  type WooOrderPayload,
  type WooProduct,
  type WooVariation,
} from "./types"
import { importWooProduct, deactivateWooProduct } from "./import-products"
import { importWooOrder, applyWooLifecycleUpdate } from "./import-orders"
import { fetchWooVariations, wooApiBase, wooAuthHeader } from "./rest"

/**
 * Shared WooCommerce webhook processor. Runs the actual DB work for one event
 * and returns a plain serializable result. Called by BOTH the inline fallback
 * (in the webhook route when no queue is configured) and the QStash worker, so
 * the sync behaves identically whichever path runs it.
 *
 * Must be given a service-role client.
 */
export type ProcessResult = {
  status: string
  [k: string]: unknown
}

export async function processWooEvent(
  supabase: SupabaseClient,
  topic: string,
  source: string,
  payload: unknown,
): Promise<ProcessResult> {
  if (topic === "order.created") {
    return handleOrderCreate(supabase, source, topic, payload as WooOrderPayload)
  }
  if (topic === "order.updated" || topic === "order.deleted") {
    return handleOrderUpdate(supabase, source, topic, payload as WooOrderPayload)
  }
  if (topic === "product.created" || topic === "product.updated") {
    return handleProductUpsert(supabase, source, payload as WooProduct)
  }
  if (topic === "product.deleted") {
    return handleProductDelete(supabase, source, payload as WooProduct)
  }
  return { status: "ignored", topic }
}

/** The active WMS site a store feeds + its order-sync floor, or null if not
 *  connected. cutoff is null when the connection has no floor set. */
async function connForSource(
  supabase: SupabaseClient,
  source: string,
): Promise<{ siteId: string; cutoff: string | null } | null> {
  const { data } = await supabase
    .from("store_connections")
    .select("site_id, sync_orders_since")
    .eq("channel", "woocommerce")
    .eq("source", source)
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
  source: string,
  topic: string,
  payload: WooOrderPayload,
): Promise<ProcessResult> {
  const conn = await connForSource(supabase, source)
  if (!conn) return { status: "no_connection" }

  const order = normalizeWooOrder(payload)
  const outcome = await importWooOrder(
    supabase,
    conn.siteId,
    source,
    order,
    topic,
    payload,
    conn.cutoff,
  )
  if (outcome.status === "duplicate") {
    const life = await applyWooLifecycleUpdate(supabase, source, order)
    return { status: "duplicate", lifecycle: life.status }
  }
  return { ...outcome }
}

async function handleOrderUpdate(
  supabase: SupabaseClient,
  source: string,
  topic: string,
  payload: WooOrderPayload,
): Promise<ProcessResult> {
  const conn = await connForSource(supabase, source)
  if (!conn) return { status: "no_connection" }

  const order = normalizeWooOrder(payload)
  // A delete/trash webhook has no status, so the derived lifecycle is "open".
  // Resolve the topic-aware lifecycle so a store-side delete cancels the WMS
  // order (releases its reservation) instead of no-opping.
  order.lifecycle = effectiveWooLifecycle(topic, order.lifecycle)
  const life = await applyWooLifecycleUpdate(supabase, source, order)

  // Update for an order we never imported -> treat as a create (self-healing).
  // The cutoff still applies, so editing a pre-go-live order can't sneak it in.
  // Exception: a delete for an order we never had is a genuine no-op — never
  // import from a delete (its payload has no line items anyway).
  if (life.status === "not_found") {
    if (topic === "order.deleted") {
      return {
        status: "lifecycle",
        result: "noop",
        reason: "deleted order not in WMS",
      }
    }
    const outcome = await importWooOrder(
      supabase,
      conn.siteId,
      source,
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
  source: string,
  product: WooProduct,
): Promise<ProcessResult> {
  const conn = await connForSource(supabase, source)
  if (!conn) return { status: "no_connection" }

  // A variable product's webhook payload carries only variation IDs, so
  // importWooProduct alone can't map them and would skip the product — which is
  // why newly added variants never showed up from a webhook. Self-heal: pull
  // the full variation objects from the Woo REST API (the same call the manual
  // product sync makes) so each variant maps to a child SKU automatically.
  //
  // Stock is deliberately NOT synced here: inbound stock stays unwired so a
  // webhook can't fight our own outbound stock pushes (see the Shopify
  // inventory_levels/update note). We only reconcile catalog structure, price,
  // and SKU.
  const looksVariable =
    (product.type ?? "").toLowerCase() === "variable" ||
    (product.variations?.length ?? 0) > 0

  let variations: WooVariation[] | undefined
  let selfHealed = false
  if (looksVariable && product.id != null) {
    const creds = await wooRestCreds(supabase, source)
    if (creds) {
      try {
        variations = await fetchWooVariations(
          wooApiBase(creds.source),
          { Authorization: wooAuthHeader(creds.key, creds.secret) },
          product.id,
        )
        selfHealed = true
      } catch {
        // Store/API unreachable — fall back to id-only behaviour (product is
        // skipped by importWooProduct). A later manual sync still catches it.
        variations = undefined
      }
    }
  }

  const result = await importWooProduct(supabase, conn.siteId, product, {
    variations,
  })
  return { status: "synced", selfHealed, ...result }
}

/**
 * REST credentials for a connected Woo store, looked up by its canonical
 * `source` with the service-role client. Returns null when the store isn't
 * connected or has no consumer key/secret stored yet. Mirrors loadCreds in the
 * integration action, but keyed by source (what the webhook carries) rather
 * than connection id.
 */
async function wooRestCreds(
  supabase: SupabaseClient,
  source: string,
): Promise<{ source: string; key: string; secret: string } | null> {
  const { data: conn } = await supabase
    .from("store_connections")
    .select("id, source")
    .eq("channel", "woocommerce")
    .eq("source", source)
    .eq("is_active", true)
    .maybeSingle()
  if (!conn?.id) return null

  const { data: secret } = await supabase
    .from("store_secrets")
    .select("consumer_key, consumer_secret")
    .eq("connection_id", conn.id)
    .maybeSingle()
  if (!secret?.consumer_key || !secret?.consumer_secret) return null

  return {
    source: (conn.source as string) ?? source,
    key: secret.consumer_key as string,
    secret: secret.consumer_secret as string,
  }
}

async function handleProductDelete(
  supabase: SupabaseClient,
  source: string,
  product: WooProduct,
): Promise<ProcessResult> {
  const conn = await connForSource(supabase, source)
  if (!conn) return { status: "no_connection" }
  const d = await deactivateWooProduct(supabase, conn.siteId, product)
  return { status: "deleted", childSkus: d.childSkus, products: d.products }
}
