import type { SupabaseClient } from "@supabase/supabase-js"

import { isBeforeSyncCutoff } from "../store-sync/cutoff"
import type { NormalizedShopifyOrder } from "./types"

export type OrderImportOutcome =
  | { status: "imported"; wmsOrderId: string }
  | { status: "duplicate" }
  | { status: "needs_mapping"; unmapped: string[] }
  | { status: "skipped"; reason: string }
  | { status: "error"; error: string }

/**
 * After an order is created, stamp it with the Shopify-facing order number and
 * move it to its Shopify lifecycle state. Shared by the backfill and the
 * orders/create webhook so both behave identically.
 *
 *  - order_number → "SHOP-<shopify name>" (e.g. "SHOP-#1001") so WMS searches
 *    match the number shown in Shopify admin. It's a plain label, so we set it
 *    with a direct update; a unique clash (re-used name) is non-fatal — we keep
 *    the auto-assigned ORD-… number and move on.
 *  - lifecycle → fulfilled orders go straight through the guarded fulfill_order
 *    (inventory consume + pick-fee snapshot, backdated to the Shopify date),
 *    cancelled orders through cancel_order. "open" is left in the normal flow.
 *
 * Lifecycle/number failures are logged but never fail the import: the order is
 * already in WMS, and its status can be corrected by hand.
 *
 * Must be called with a service-role client (writes orders, calls the RPCs).
 */
export async function applyShopifyOrderMeta(
  client: SupabaseClient,
  wmsOrderId: string,
  order: NormalizedShopifyOrder,
): Promise<void> {
  if (order.name) {
    const orderNumber = `SHOP-${order.name}`
    const { error } = await client
      .from("orders")
      .update({ order_number: orderNumber })
      .eq("id", wmsOrderId)
    if (error && error.code !== "23505") {
      console.error(
        `[shopify] could not set order_number ${orderNumber}: ${error.message}`,
      )
    }
  }

  if (order.lifecycle === "fulfilled") {
    const { error } = await client.rpc("fulfill_order", {
      p_order_id: wmsOrderId,
      p_fulfilled_at: order.fulfilledAt ?? order.createdAt,
    })
    if (error) {
      console.error(
        `[shopify] fulfill_order failed for ${wmsOrderId}: ${error.message}`,
      )
    }
  } else if (order.lifecycle === "cancelled") {
    const { error } = await client.rpc("cancel_order", {
      p_order_id: wmsOrderId,
    })
    if (error) {
      console.error(
        `[shopify] cancel_order failed for ${wmsOrderId}: ${error.message}`,
      )
    }
  }
}

export type LifecycleUpdateOutcome =
  | { status: "fulfilled"; wmsOrderId: string }
  | { status: "cancelled"; wmsOrderId: string }
  | { status: "noop"; reason: string }
  | { status: "not_found" }
  | { status: "error"; error: string }

/**
 * Reconcile an already-imported Shopify order's lifecycle from an
 * orders/updated|cancelled|fulfilled webhook. The order-level idempotency key
 * means importNormalizedOrder() refuses to CREATE a second time; this is the
 * companion path that, for an order we already have, pushes a later
 * fulfilled/cancelled state into WMS through the SAME guarded RPCs.
 *
 * Conflict rule (per the WMS spec): the STORE owns the order's own lifecycle, so
 * a store-side fulfilled/cancelled wins here. We only ever move an order FORWARD
 * (open -> fulfilled/cancelled); we never reopen a WMS order from a webhook,
 * because WMS may have packed/shipped it locally and that must not be undone by
 * a stale store event. Returns "not_found" when the order isn't in WMS yet so
 * the caller can fall back to importing it (a create-or-update).
 *
 * Must be called with a service-role client.
 */
export async function applyShopifyLifecycleUpdate(
  client: SupabaseClient,
  shopDomain: string,
  order: NormalizedShopifyOrder,
): Promise<LifecycleUpdateOutcome> {
  if (!order.shopifyOrderId) return { status: "error", error: "missing order id" }

  // Find the WMS order this Shopify order was imported as.
  const { data: imp } = await client
    .from("store_order_imports")
    .select("wms_order_id")
    .eq("channel", "shopify")
    .eq("source", shopDomain)
    .eq("external_order_id", order.shopifyOrderId)
    .not("wms_order_id", "is", null)
    .maybeSingle()
  const wmsOrderId = imp?.wms_order_id as string | undefined
  if (!wmsOrderId) return { status: "not_found" }

  if (order.lifecycle === "open") {
    return { status: "noop", reason: "store order still open" }
  }

  const { data: current } = await client
    .from("orders")
    .select("status")
    .eq("id", wmsOrderId)
    .maybeSingle()
  const status = current?.status as string | undefined
  if (!status) return { status: "not_found" }
  // Already in a terminal state — nothing to do (and the guarded RPCs would
  // raise). This is what makes re-delivered update events a safe no-op.
  if (status === "fulfilled" || status === "cancelled") {
    return { status: "noop", reason: `already ${status}` }
  }

  if (order.lifecycle === "fulfilled") {
    const { error } = await client.rpc("fulfill_order", {
      p_order_id: wmsOrderId,
      p_fulfilled_at: order.fulfilledAt ?? order.createdAt,
    })
    if (error) return { status: "error", error: error.message }
    return { status: "fulfilled", wmsOrderId }
  }

  // cancelled
  const { error } = await client.rpc("cancel_order", { p_order_id: wmsOrderId })
  if (error) return { status: "error", error: error.message }
  return { status: "cancelled", wmsOrderId }
}

/**
 * Import one normalized Shopify order into WMS. Shared by the orders/create
 * webhook and the past-orders backfill so both behave identically:
 *
 *  - idempotent on (channel, source, external_order_id) via store_order_imports
 *  - maps Shopify variant ids -> child SKUs at the order's site
 *  - resolves/creates the customer by email
 *  - writes the order through the guarded create_order RPC
 *
 * Unlike the webhook, this backdates the WMS order to the original Shopify
 * created_at (sale_date + entered_at) so historical orders keep their real date.
 *
 * Must be called with a service-role client: it writes store_order_imports
 * (no RLS write policy) and reads across customers/child_skus.
 *
 * `cutoff` is the connection's sync_orders_since floor: an order created before
 * it is skipped BEFORE the idempotency insert, so no tombstone is written and a
 * later cutoff change lets a re-sync pick it up. Guards both the backfill and
 * the webhook self-heal path (an old order edited in Shopify fires orders/updated
 * -> not_found -> here). Pass null for no floor.
 */
export async function importNormalizedOrder(
  client: SupabaseClient,
  siteId: string,
  shopDomain: string,
  order: NormalizedShopifyOrder,
  topic: string,
  rawPayload: unknown,
  cutoff: string | null = null,
): Promise<OrderImportOutcome> {
  if (!order.shopifyOrderId) {
    return { status: "error", error: "missing order id" }
  }

  // Sync floor: never ingest orders older than the store's go-live cutoff.
  if (isBeforeSyncCutoff(order.createdAt, cutoff)) {
    return { status: "skipped", reason: "before sync cutoff" }
  }

  // Idempotency: a re-run (or Shopify retry) hits the unique key and is skipped.
  const { data: importRow, error: insErr } = await client
    .from("store_order_imports")
    .insert({
      channel: "shopify",
      source: shopDomain,
      external_order_id: order.shopifyOrderId,
      topic,
      status: "received",
      payload: rawPayload,
    })
    .select("id")
    .single()

  if (insErr) {
    if (insErr.code === "23505") return { status: "duplicate" }
    return { status: "error", error: insErr.message }
  }

  const importId = importRow.id as string
  const finish = (
    status: string,
    extra: { error?: string; wms_order_id?: string } = {},
  ) =>
    client
      .from("store_order_imports")
      .update({ status, processed_at: new Date().toISOString(), ...extra })
      .eq("id", importId)

  if (order.lines.length === 0) {
    await finish("error", { error: "Order has no mappable line items" })
    return { status: "skipped", reason: "empty" }
  }

  // Map Shopify variant ids -> child SKUs at this site.
  const variantIds = order.lines
    .map((l) => l.variantId)
    .filter((v): v is string => Boolean(v))
  const { data: skus } = await client
    .from("child_skus")
    .select("id, store_variant_id")
    .eq("site_id", siteId)
    .eq("is_active", true)
    .in("store_variant_id", variantIds)
  const skuByVariant = new Map(
    (skus ?? []).map((s) => [s.store_variant_id as string, s.id as string]),
  )

  const mappedLines: {
    child_sku_id: string
    quantity: number
    unit_price: number | null
  }[] = []
  const unmapped: string[] = []
  for (const line of order.lines) {
    const childSkuId = line.variantId
      ? skuByVariant.get(line.variantId)
      : undefined
    if (!childSkuId) {
      unmapped.push(line.variantId ?? line.title ?? "unknown")
      continue
    }
    mappedLines.push({
      child_sku_id: childSkuId,
      quantity: line.quantity,
      unit_price: line.unitPrice,
    })
  }

  if (unmapped.length > 0) {
    await finish("needs_mapping", {
      error: `Unmapped Shopify variants: ${unmapped.join(", ")}. Sync products or set store_variant_id, then re-run.`,
    })
    return { status: "needs_mapping", unmapped }
  }

  // Resolve / create the customer (by email).
  let customerId: string | null = null
  if (order.customer?.email) {
    const email = order.customer.email
    const { data: existing } = await client
      .from("customers")
      .select("id")
      .ilike("email", email)
      .limit(1)
      .maybeSingle()
    if (existing) {
      customerId = existing.id as string
    } else {
      const { data: created } = await client
        .from("customers")
        .insert({
          name: order.customer.name,
          email,
          external_ref: order.customer.externalId
            ? { shopify_customer_id: order.customer.externalId }
            : null,
        })
        .select("id")
        .single()
      customerId = created?.id ?? null
    }
  }

  // Backdate to the original Shopify order time when present.
  const saleDate = order.createdAt ? order.createdAt.slice(0, 10) : null

  const { data: newOrderId, error: createErr } = await client.rpc(
    "create_order",
    {
      p_site_id: siteId,
      p_lines: mappedLines,
      p_customer_id: customerId,
      p_channel: "shopify",
      p_order_type: "standard",
      // Store sale already happened; never lose it to short stock — backorder
      // the shortfall instead of failing (manual orders still hard-fail).
      p_allow_backorder: true,
      p_sale_date: saleDate,
      p_entered_at: order.createdAt ?? null,
      p_ship_to_name: order.shipTo?.name ?? null,
      p_ship_to_address1: order.shipTo?.address1 ?? null,
      p_ship_to_address2: order.shipTo?.address2 ?? null,
      p_ship_to_city: order.shipTo?.city ?? null,
      p_ship_to_region: order.shipTo?.region ?? null,
      p_ship_to_postal: order.shipTo?.postal ?? null,
      p_ship_to_country: order.shipTo?.country ?? null,
      p_notes: order.note
        ? `Shopify ${order.name ?? order.shopifyOrderId}: ${order.note}`
        : `Imported from Shopify ${order.name ?? order.shopifyOrderId}`,
    },
  )

  if (createErr) {
    await finish("error", { error: createErr.message })
    return { status: "error", error: createErr.message }
  }

  // Stamp the Shopify order number and reflect its fulfilled/cancelled state.
  await applyShopifyOrderMeta(client, newOrderId as string, order)

  await finish("imported", { wms_order_id: newOrderId as string })
  return { status: "imported", wmsOrderId: newOrderId as string }
}
