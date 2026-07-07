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
