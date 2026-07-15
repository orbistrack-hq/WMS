"use server"

import { revalidatePath } from "next/cache"

import { createClient } from "@/lib/supabase/server"
import { kickOutboundDrain } from "@/lib/store-sync/outbound"
import type { OrderChannel, OrderType } from "@/lib/orders/types"
import { LABEL_STATUSES } from "@/lib/orders/types"

export type ActionResult<T = unknown> =
  | ({ ok: true } & T)
  | { ok: false; error: string }

export type CreateOrderLine = {
  child_sku_id: string
  quantity: number
  unit_price?: number | null
}

export type CreateOrderInput = {
  site_id: string
  customer_id?: string | null
  channel?: OrderChannel
  order_type?: OrderType
  sale_date?: string | null
  ship_to_name?: string | null
  ship_to_address1?: string | null
  ship_to_address2?: string | null
  ship_to_city?: string | null
  ship_to_region?: string | null
  ship_to_postal?: string | null
  ship_to_country?: string | null
  notes?: string | null
  lines: CreateOrderLine[]
}

/** Surface the cleanest available message from a PostgREST/RPC error. */
function rpcError(error: { message?: string; details?: string } | null): string {
  if (!error) return "Something went wrong."
  // Strip the Postgres context prefix some RAISE messages carry.
  return error.message || error.details || "Something went wrong."
}

export async function createOrder(
  input: CreateOrderInput,
): Promise<ActionResult<{ orderId: string }>> {
  if (!input.site_id) return { ok: false, error: "Pick a site." }
  if (!input.lines?.length)
    return { ok: false, error: "Add at least one line item." }

  const supabase = await createClient()
  const { data, error } = await supabase.rpc("create_order", {
    p_site_id: input.site_id,
    p_lines: input.lines,
    p_customer_id: input.customer_id ?? null,
    p_channel: input.channel ?? "manual",
    p_order_type: input.order_type ?? "standard",
    p_sale_date: input.sale_date ?? null,
    p_ship_to_name: input.ship_to_name ?? null,
    p_ship_to_address1: input.ship_to_address1 ?? null,
    p_ship_to_address2: input.ship_to_address2 ?? null,
    p_ship_to_city: input.ship_to_city ?? null,
    p_ship_to_region: input.ship_to_region ?? null,
    p_ship_to_postal: input.ship_to_postal ?? null,
    p_ship_to_country: input.ship_to_country ?? null,
    p_notes: input.notes ?? null,
  })

  if (error) return { ok: false, error: rpcError(error) }

  revalidatePath("/orders")
  revalidatePath("/inventory")
  // Reserving stock changed available — push it to any outbound-enabled store.
  await kickOutboundDrain()
  return { ok: true, orderId: data as string }
}

export async function setStatus(
  orderId: string,
  status: (typeof LABEL_STATUSES)[number],
): Promise<ActionResult> {
  if (!LABEL_STATUSES.includes(status))
    return { ok: false, error: `Cannot move to ${status} here.` }

  const supabase = await createClient()
  const { error } = await supabase.rpc("set_order_status", {
    p_order_id: orderId,
    p_new_status: status,
  })
  if (error) return { ok: false, error: rpcError(error) }

  revalidatePath(`/orders/${orderId}`)
  revalidatePath("/orders")
  return { ok: true }
}

export async function fulfillOrder(orderId: string): Promise<ActionResult> {
  const supabase = await createClient()
  const { error } = await supabase.rpc("fulfill_order", { p_order_id: orderId })
  if (error) return { ok: false, error: rpcError(error) }

  revalidatePath(`/orders/${orderId}`)
  revalidatePath("/orders")
  revalidatePath("/inventory")
  await kickOutboundDrain()
  return { ok: true }
}

/**
 * Force-fulfill a backordered order that already shipped — admin/manager only.
 * Inventory-neutral: releases each line's reserved portion and clears the
 * backorder but leaves on_hand alone (the shelf is recounted separately). The
 * reason is required and written to the audit log. The DB gates the role, so a
 * non-elevated caller gets a clean "requires the admin or manager role" error.
 */
export async function forceFulfillOrder(
  orderId: string,
  reason: string,
): Promise<ActionResult> {
  const trimmed = reason?.trim()
  if (!trimmed) return { ok: false, error: "A reason is required to force-fulfill." }

  const supabase = await createClient()
  const { error } = await supabase.rpc("force_fulfill_order", {
    p_order_id: orderId,
    p_reason: trimmed,
  })
  if (error) return { ok: false, error: rpcError(error) }

  revalidatePath(`/orders/${orderId}`)
  revalidatePath("/orders")
  revalidatePath("/inventory")
  revalidatePath("/reports/backorders")
  await kickOutboundDrain()
  return { ok: true }
}

export async function cancelOrder(orderId: string): Promise<ActionResult> {
  const supabase = await createClient()
  const { error } = await supabase.rpc("cancel_order", { p_order_id: orderId })
  if (error) return { ok: false, error: rpcError(error) }

  revalidatePath(`/orders/${orderId}`)
  revalidatePath("/orders")
  revalidatePath("/inventory")
  await kickOutboundDrain()
  return { ok: true }
}

/**
 * Mark a fulfilled order RETURNED (bounced back to us). Restocks each line to
 * sellable on_hand; the pick fee/postage stand and consumables are written off
 * (handled in return_order). Available rose, so push the new levels to stores.
 */
export async function returnOrder(orderId: string): Promise<ActionResult> {
  const supabase = await createClient()
  const { error } = await supabase.rpc("return_order", { p_order_id: orderId })
  if (error) return { ok: false, error: rpcError(error) }

  revalidatePath(`/orders/${orderId}`)
  revalidatePath("/orders")
  revalidatePath("/inventory")
  await kickOutboundDrain()
  return { ok: true }
}

/**
 * Mark an OPEN order as completed at the store — for orders that shipped outside
 * OT (e.g. ShipStation) and just need recording here. Marks it fulfilled,
 * auto_fulfilled, and closes the group.
 *
 *  - default (no consume): fulfill_order_no_stock — releases the reservation and
 *    clears any backorder but leaves on_hand ALONE, because the item already left
 *    before OT tracked this stock. Inventory-neutral.
 *  - consume: normal fulfill_order — depletes on_hand. Use only when OT's stock
 *    should reflect this shipment (a live order OT reserved real stock for).
 */
export async function markCompletedAtStore(
  orderId: string,
  opts: { consume?: boolean } = {},
): Promise<ActionResult> {
  const supabase = await createClient()
  const { error } = opts.consume
    ? await supabase.rpc("fulfill_order", {
        p_order_id: orderId,
        p_auto_fulfilled: true,
      })
    : await supabase.rpc("fulfill_order_no_stock", { p_order_id: orderId })
  if (error) return { ok: false, error: rpcError(error) }

  revalidatePath(`/orders/${orderId}`)
  revalidatePath("/orders")
  revalidatePath("/inventory")
  await kickOutboundDrain()
  return { ok: true }
}

/** Re-open a returned order (returned → created); re-reserves its stock. */
export async function reopenOrder(orderId: string): Promise<ActionResult> {
  const supabase = await createClient()
  const { error } = await supabase.rpc("reopen_order", { p_order_id: orderId })
  if (error) return { ok: false, error: rpcError(error) }

  revalidatePath(`/orders/${orderId}`)
  revalidatePath("/orders")
  revalidatePath("/inventory")
  await kickOutboundDrain()
  return { ok: true }
}

export async function toggleHold(
  orderId: string,
  onHold: boolean,
): Promise<ActionResult> {
  const supabase = await createClient()
  const { error } = await supabase
    .from("orders")
    .update({ on_hold: onHold })
    .eq("id", orderId)
  if (error) return { ok: false, error: rpcError(error) }

  revalidatePath(`/orders/${orderId}`)
  revalidatePath("/orders")
  return { ok: true }
}

export async function combineOrders(
  orderIds: string[],
): Promise<ActionResult<{ groupId: string }>> {
  if (!orderIds || orderIds.length < 2)
    return { ok: false, error: "Select at least two orders to combine." }

  const supabase = await createClient()
  const { data, error } = await supabase.rpc("combine_orders", {
    p_order_ids: orderIds,
  })
  if (error) return { ok: false, error: rpcError(error) }

  for (const id of orderIds) revalidatePath(`/orders/${id}`)
  revalidatePath("/orders")
  return { ok: true, groupId: data as string }
}

// ---------------------------------------------------------------------------
// Bulk actions. The team fulfils/moves many orders at once, so these run the
// same per-order RPCs in a loop and report per-order outcomes rather than
// failing the whole batch on one bad order (skip + report). Revalidation and
// the outbound push happen once, after the loop.
// ---------------------------------------------------------------------------

export type BulkFailure = { orderId: string; error: string }
export type BulkResult =
  | { ok: true; succeeded: string[]; failed: BulkFailure[] }
  | { ok: false; error: string }

/** Bulk fulfil: attempt fulfill_order per order, collect failures, keep going. */
export async function bulkFulfill(orderIds: string[]): Promise<BulkResult> {
  if (!orderIds?.length) return { ok: false, error: "No orders selected." }

  const supabase = await createClient()
  const succeeded: string[] = []
  const failed: BulkFailure[] = []

  for (const orderId of orderIds) {
    const { error } = await supabase.rpc("fulfill_order", { p_order_id: orderId })
    if (error) failed.push({ orderId, error: rpcError(error) })
    else succeeded.push(orderId)
  }

  if (succeeded.length) {
    revalidatePath("/orders")
    revalidatePath("/inventory")
    revalidatePath("/packing")
    await kickOutboundDrain()
  }
  return { ok: true, succeeded, failed }
}

/**
 * Bulk force-fulfill backordered orders that already shipped — admin/manager
 * only (the DB gates the role, so a non-elevated caller gets every order back
 * as a failure rather than a silent bypass). Inventory-neutral per order; the
 * same reason is written to each order's audit log. Skip + report like the other
 * bulk actions.
 */
export async function bulkForceFulfill(
  orderIds: string[],
  reason: string,
): Promise<BulkResult> {
  if (!orderIds?.length) return { ok: false, error: "No orders selected." }
  const trimmed = reason?.trim()
  if (!trimmed) return { ok: false, error: "A reason is required to force-fulfill." }

  const supabase = await createClient()
  const succeeded: string[] = []
  const failed: BulkFailure[] = []

  for (const orderId of orderIds) {
    const { error } = await supabase.rpc("force_fulfill_order", {
      p_order_id: orderId,
      p_reason: trimmed,
    })
    if (error) failed.push({ orderId, error: rpcError(error) })
    else succeeded.push(orderId)
  }

  if (succeeded.length) {
    revalidatePath("/orders")
    revalidatePath("/inventory")
    revalidatePath("/reports/backorders")
    await kickOutboundDrain()
  }
  return { ok: true, succeeded, failed }
}

/** Bulk label move (created/picking/packed) via set_order_status. */
export async function bulkSetStatus(
  orderIds: string[],
  status: (typeof LABEL_STATUSES)[number],
): Promise<BulkResult> {
  if (!orderIds?.length) return { ok: false, error: "No orders selected." }
  if (!LABEL_STATUSES.includes(status))
    return { ok: false, error: `Cannot bulk-move to ${status}.` }

  const supabase = await createClient()
  const succeeded: string[] = []
  const failed: BulkFailure[] = []

  for (const orderId of orderIds) {
    const { error } = await supabase.rpc("set_order_status", {
      p_order_id: orderId,
      p_new_status: status,
    })
    if (error) failed.push({ orderId, error: rpcError(error) })
    else succeeded.push(orderId)
  }

  if (succeeded.length) revalidatePath("/orders")
  return { ok: true, succeeded, failed }
}

/** Bulk hold / unhold. Stock stays reserved either way, so no outbound push. */
export async function bulkSetHold(
  orderIds: string[],
  onHold: boolean,
): Promise<BulkResult> {
  if (!orderIds?.length) return { ok: false, error: "No orders selected." }

  const supabase = await createClient()
  const { error } = await supabase
    .from("orders")
    .update({ on_hold: onHold })
    .in("id", orderIds)
  if (error) return { ok: false, error: rpcError(error) }

  revalidatePath("/orders")
  return { ok: true, succeeded: orderIds, failed: [] }
}

export async function recordPayment(
  orderId: string,
  amount: number,
  method?: string | null,
  note?: string | null,
): Promise<ActionResult> {
  if (!(amount > 0))
    return { ok: false, error: "Payment amount must be positive." }

  const supabase = await createClient()
  const { error } = await supabase.rpc("record_order_payment", {
    p_order_id: orderId,
    p_amount: amount,
    p_method: method ?? null,
    p_note: note ?? null,
  })
  if (error) return { ok: false, error: rpcError(error) }

  revalidatePath(`/orders/${orderId}`)
  return { ok: true }
}
