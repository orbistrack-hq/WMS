import type { SupabaseClient } from "@supabase/supabase-js"

import {
  effectiveWooLifecycle,
  normalizeWooOrder,
  type WooOrderPayload,
  type WooProduct,
} from "./types"
import { importWooProduct, deactivateWooProduct } from "./import-products"
import { importWooOrder, applyWooLifecycleUpdate } from "./import-orders"

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
  const result = await importWooProduct(supabase, conn.siteId, product)
  return { status: "synced", ...result }
}

async function handleProductDelete(
  supabase: SupabaseClient,
  source: string,
  product: WooProduct,
): Promise<ProcessResult> {
  const conn = await connForSource(supabase, source)
  if (!conn) return { status: "no_connection" }
  const deactivated = await deactivateWooProduct(supabase, conn.siteId, product)
  return { status: "deleted", deactivated }
}
