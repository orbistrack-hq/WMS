import type { SupabaseClient } from "@supabase/supabase-js"

import { storeAutoFulfillEnabled } from "../store-sync/config"
import { isBeforeSyncCutoff } from "../store-sync/cutoff"
import { applyToHeldOrder } from "../store-sync/promote"
import { markStoreCompleted } from "../store-sync/store-completed"
import type { NormalizedStoreOrder } from "./types"

export type OrderImportOutcome =
  | { status: "imported"; wmsOrderId: string }
  | { status: "duplicate" }
  | { status: "needs_mapping"; unmapped: string[] }
  | { status: "skipped"; reason: string }
  | { status: "error"; error: string }

/**
 * After a Woo order is created, stamp it with the Woo order number and move it
 * to its lifecycle state. Shared by the webhook and the backfill so both behave
 * identically.
 *
 *  - order_number → "WOO-<number>" so WMS searches match the Woo order number.
 *    A unique clash is non-fatal — keep the auto-assigned ORD-… number.
 *  - lifecycle → completed orders go through the guarded fulfill_order
 *    (inventory consume + pick-fee, backdated), cancelled/refunded/failed
 *    through cancel_order. "open" stays in the normal pick/pack flow.
 *
 * Lifecycle/number failures are logged but never fail the import: the order is
 * already in WMS and its status can be corrected by hand.
 *
 * Must be called with a service-role client (writes orders, calls the RPCs).
 */
export async function applyWooOrderMeta(
  client: SupabaseClient,
  wmsOrderId: string,
  order: NormalizedStoreOrder,
): Promise<void> {
  if (order.number) {
    const orderNumber = `WOO-${order.number}`
    const { error } = await client
      .from("orders")
      .update({ order_number: orderNumber })
      .eq("id", wmsOrderId)
    if (error && error.code !== "23505") {
      console.error(
        `[woocommerce] could not set order_number ${orderNumber}: ${error.message}`,
      )
    }
  }

  // Woo `on-hold` — active/shippable, but flag on_hold so staff see it's
  // awaiting payment clearance. Only for an open order (a fulfilled/cancelled
  // one has moved past the hold). Non-fatal on error.
  if (order.lifecycle === "open" && order.onHold) {
    const { error } = await client
      .from("orders")
      .update({ on_hold: true })
      .eq("id", wmsOrderId)
    if (error) {
      console.error(
        `[woocommerce] could not set on_hold for ${wmsOrderId}: ${error.message}`,
      )
    }
  }

  if (order.lifecycle === "fulfilled") {
    if (storeAutoFulfillEnabled()) {
      const { error } = await client.rpc("fulfill_order", {
        p_order_id: wmsOrderId,
        p_fulfilled_at: order.fulfilledAt ?? order.createdAt,
        // Store completed it upstream (e.g. ShipStation shipped it) before/without
        // local packing — mark it so it's distinguishable from a local pack and
        // surfaces in the packaging-gap report for after-the-fact cost capture.
        p_auto_fulfilled: true,
      })
      if (error) {
        console.error(
          `[woocommerce] fulfill_order failed for ${wmsOrderId}: ${error.message}`,
        )
      }
    } else {
      // Auto-fulfill disabled — leave the order in the normal pick/pack flow so
      // the team packs it and costs are captured, but stamp store_completed_at so
      // it shows as "completed at store".
      await markStoreCompleted(
        client,
        wmsOrderId,
        order.fulfilledAt ?? order.createdAt,
      )
    }
  } else if (order.lifecycle === "cancelled") {
    const { error } = await client.rpc("cancel_order", {
      p_order_id: wmsOrderId,
    })
    if (error) {
      console.error(
        `[woocommerce] cancel_order failed for ${wmsOrderId}: ${error.message}`,
      )
    }
  }
}

export type LifecycleUpdateOutcome =
  | { status: "fulfilled"; wmsOrderId: string }
  | { status: "cancelled"; wmsOrderId: string }
  | { status: "activated"; wmsOrderId: string }
  | { status: "noop"; reason: string }
  | { status: "not_found" }
  | { status: "error"; error: string }

/**
 * Reconcile an already-imported Woo order's lifecycle from an order.updated /
 * order.deleted webhook. Companion to importWooOrder(): the order-level
 * idempotency key blocks a second CREATE, so this pushes a later
 * completed/cancelled state into WMS through the same guarded RPCs.
 *
 * Conflict rule (per the WMS spec): the STORE owns the order's own lifecycle, so
 * a store-side completed/cancelled wins. We only ever move an order FORWARD
 * (open -> fulfilled/cancelled) and never reopen a WMS order from a webhook,
 * since WMS may have packed/shipped it locally. Returns "not_found" when the
 * order isn't in WMS yet so the caller can fall back to importing it.
 *
 * Must be called with a service-role client.
 */
export async function applyWooLifecycleUpdate(
  client: SupabaseClient,
  source: string,
  order: NormalizedStoreOrder,
): Promise<LifecycleUpdateOutcome> {
  if (!order.externalOrderId) return { status: "error", error: "missing order id" }

  const { data: imp } = await client
    .from("store_order_imports")
    .select("wms_order_id")
    .eq("channel", "woocommerce")
    .eq("source", source)
    .eq("external_order_id", order.externalOrderId)
    .not("wms_order_id", "is", null)
    .maybeSingle()
  const wmsOrderId = imp?.wms_order_id as string | undefined
  if (!wmsOrderId) return { status: "not_found" }

  const { data: current } = await client
    .from("orders")
    .select("status")
    .eq("id", wmsOrderId)
    .maybeSingle()
  const status = current?.status as string | undefined
  if (!status) return { status: "not_found" }
  if (status === "fulfilled" || status === "cancelled") {
    return { status: "noop", reason: `already ${status}` }
  }

  // Held awaiting payment: promote / cancel per the store's transition.
  if (status === "pending_payment") {
    return applyToHeldOrder(client, wmsOrderId, order)
  }

  // Active order (created/picking/packed) — already reserved.
  if (order.lifecycle === "open") {
    return { status: "noop", reason: "store order still open" }
  }

  if (order.lifecycle === "fulfilled") {
    if (!storeAutoFulfillEnabled()) {
      // Auto-fulfill disabled — do NOT fulfil. Leave the order in the pick/pack
      // flow so packaging/costs are captured locally, but stamp store_completed_at
      // so it surfaces as "completed at store" without a manual reconcile.
      await markStoreCompleted(
        client,
        wmsOrderId,
        order.fulfilledAt ?? order.createdAt,
      )
      return {
        status: "noop",
        reason: "auto-fulfill disabled; marked completed at store, left for local packing",
      }
    }
    const { error } = await client.rpc("fulfill_order", {
      p_order_id: wmsOrderId,
      p_fulfilled_at: order.fulfilledAt ?? order.createdAt,
      // Completed upstream after we imported it — mark as an auto-fulfillment.
      p_auto_fulfilled: true,
    })
    if (error) return { status: "error", error: error.message }
    return { status: "fulfilled", wmsOrderId }
  }

  const { error } = await client.rpc("cancel_order", { p_order_id: wmsOrderId })
  if (error) return { status: "error", error: error.message }
  return { status: "cancelled", wmsOrderId }
}

/**
 * Import one normalized Woo order into WMS. Shared by the order webhook and the
 * past-orders backfill so both behave identically:
 *
 *  - idempotent on (channel, source, external_order_id) via store_order_imports
 *  - maps Woo product/variation ids -> child SKUs at the order's site
 *  - resolves/creates the customer by email
 *  - writes the order through the guarded create_order RPC, backdated to the
 *    original Woo date so historical orders keep their real sale date
 *  - stamps the Woo order number and reflects completed/cancelled state
 *
 * Must be called with a service-role client: it writes store_order_imports
 * (no RLS write policy) and reads across customers/child_skus.
 *
 * `cutoff` is the connection's sync_orders_since floor: an order created before
 * it is skipped BEFORE the idempotency insert, so no tombstone is written and a
 * later cutoff change lets a re-sync pick it up. Guards both the backfill and
 * the webhook self-heal path (an old order edited in Woo fires order.updated ->
 * not_found -> here). Pass null for no floor.
 */
export async function importWooOrder(
  client: SupabaseClient,
  siteId: string,
  source: string,
  order: NormalizedStoreOrder,
  topic: string,
  rawPayload: unknown,
  cutoff: string | null = null,
): Promise<OrderImportOutcome> {
  if (!order.externalOrderId) {
    return { status: "error", error: "missing order id" }
  }

  // Sync floor: never ingest orders older than the store's go-live cutoff.
  if (isBeforeSyncCutoff(order.createdAt, cutoff)) {
    return { status: "skipped", reason: "before sync cutoff" }
  }

  // Idempotency: a re-run (or Woo retry) hits the unique key and is skipped.
  const { data: importRow, error: insErr } = await client
    .from("store_order_imports")
    .insert({
      channel: "woocommerce",
      source,
      external_order_id: order.externalOrderId,
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

  // Map Woo product/variation ids -> child SKUs at this site.
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
      error: `Unmapped WooCommerce items: ${unmapped.join(", ")}. Sync products (variable products need a sync to map their variations), then re-run.`,
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
            ? { woocommerce_customer_id: order.customer.externalId }
            : null,
        })
        .select("id")
        .single()
      customerId = created?.id ?? null
    }
  }

  // Backdate to the original Woo order time when present.
  const saleDate = order.createdAt ? order.createdAt.slice(0, 10) : null
  const label = order.number ?? order.externalOrderId

  // Hold an unpaid open order: it's created as pending_payment and reserves no
  // stock until payment clears (activate_pending_order). Fulfilled/cancelled
  // orders are never held — their lifecycle is applied straight away.
  const hold = order.lifecycle === "open" && !order.paid

  const { data: newOrderId, error: createErr } = await client.rpc(
    "create_order",
    {
      p_site_id: siteId,
      p_lines: mappedLines,
      p_customer_id: customerId,
      p_channel: "woocommerce",
      p_order_type: "standard",
      // Store sale already happened; never lose it to short stock — backorder
      // the shortfall instead of failing (manual orders still hard-fail).
      p_allow_backorder: true,
      p_hold: hold,
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
        ? `WooCommerce #${label}: ${order.note}`
        : `Imported from WooCommerce #${label}`,
    },
  )

  if (createErr) {
    await finish("error", { error: createErr.message })
    return { status: "error", error: createErr.message }
  }

  // Stamp the Woo order number and reflect its completed/cancelled state.
  await applyWooOrderMeta(client, newOrderId as string, order)

  await finish("imported", { wms_order_id: newOrderId as string })
  return { status: "imported", wmsOrderId: newOrderId as string }
}
