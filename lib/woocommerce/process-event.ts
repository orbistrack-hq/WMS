import type { SupabaseClient } from "@supabase/supabase-js"

import {
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

/** The active WMS site a store feeds, or null if not connected. */
async function siteForSource(
  supabase: SupabaseClient,
  source: string,
): Promise<string | null> {
  const { data } = await supabase
    .from("store_connections")
    .select("site_id")
    .eq("channel", "woocommerce")
    .eq("source", source)
    .eq("is_active", true)
    .maybeSingle()
  return (data?.site_id as string) ?? null
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
  const siteId = await siteForSource(supabase, source)
  if (!siteId) return { status: "no_connection" }

  const order = normalizeWooOrder(payload)
  const outcome = await importWooOrder(supabase, siteId, source, order, topic, payload)
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
  const siteId = await siteForSource(supabase, source)
  if (!siteId) return { status: "no_connection" }

  const order = normalizeWooOrder(payload)
  const life = await applyWooLifecycleUpdate(supabase, source, order)

  // Update for an order we never imported -> treat as a create (self-healing).
  if (life.status === "not_found") {
    const outcome = await importWooOrder(supabase, siteId, source, order, topic, payload)
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
  const siteId = await siteForSource(supabase, source)
  if (!siteId) return { status: "no_connection" }
  const result = await importWooProduct(supabase, siteId, product)
  return { status: "synced", ...result }
}

async function handleProductDelete(
  supabase: SupabaseClient,
  source: string,
  product: WooProduct,
): Promise<ProcessResult> {
  const siteId = await siteForSource(supabase, source)
  if (!siteId) return { status: "no_connection" }
  const deactivated = await deactivateWooProduct(supabase, siteId, product)
  return { status: "deleted", deactivated }
}
