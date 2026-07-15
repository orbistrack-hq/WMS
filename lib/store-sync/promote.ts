import type { SupabaseClient } from "@supabase/supabase-js"

import { storeAutoFulfillEnabled } from "./config"
import { markStoreCompleted } from "./store-completed"

// ---------------------------------------------------------------------------
// Held-order promotion — shared by the Shopify and WooCommerce lifecycle
// reconcilers. An order imported while unpaid sits in WMS as `pending_payment`
// (reserves no stock, stays out of the pick/pack queue). When the store reports
// a payment/lifecycle transition, this decides what happens to that held order:
//
//   store now paid (open)      -> activate: reserve stock, -> created
//   store paid + shipped       -> activate then fulfil (if auto-fulfill on)
//   store cancelled/denied      -> cancel (releases nothing; it never reserved)
//   still unpaid                -> no-op, keep holding
//
// Reserving only at payment is the whole point: we never set aside stock for
// money the store hasn't collected, and WMS's active order count matches
// ShipStation (which also only sees paid orders).
// ---------------------------------------------------------------------------

/** The minimal signal both channels' normalized orders expose. */
export type HeldOrderSignal = {
  lifecycle: "open" | "fulfilled" | "cancelled"
  paid: boolean
  fulfilledAt: string | null
  createdAt: string | null
}

export type HeldOutcome =
  | { status: "activated"; wmsOrderId: string }
  | { status: "fulfilled"; wmsOrderId: string }
  | { status: "cancelled"; wmsOrderId: string }
  | { status: "noop"; reason: string }
  | { status: "error"; error: string }

/**
 * Apply a store lifecycle/payment transition to a WMS order still held as
 * `pending_payment`. Must be called with a service-role client. Idempotent:
 * activate_pending_order no-ops if the order was already promoted, so a
 * re-delivered paid webhook is safe.
 */
export async function applyToHeldOrder(
  client: SupabaseClient,
  wmsOrderId: string,
  order: HeldOrderSignal,
): Promise<HeldOutcome> {
  // Denied / cancelled while held — release the hold (no stock to return).
  if (order.lifecycle === "cancelled") {
    const { error } = await client.rpc("cancel_order", { p_order_id: wmsOrderId })
    if (error) return { status: "error", error: error.message }
    return { status: "cancelled", wmsOrderId }
  }

  // Paid AND shipped upstream while we held it: reserve first (activate), then
  // fulfil — you can't consume stock that was never reserved.
  if (order.lifecycle === "fulfilled") {
    const { error: aerr } = await client.rpc("activate_pending_order", {
      p_order_id: wmsOrderId,
    })
    if (aerr) return { status: "error", error: aerr.message }
    if (!storeAutoFulfillEnabled()) {
      // Reserved and in the local pick flow; leave the actual fulfil to packing,
      // but stamp store_completed_at so it shows as "completed at store".
      await markStoreCompleted(client, wmsOrderId, order.fulfilledAt ?? order.createdAt)
      return { status: "activated", wmsOrderId }
    }
    const { error } = await client.rpc("fulfill_order", {
      p_order_id: wmsOrderId,
      p_fulfilled_at: order.fulfilledAt ?? order.createdAt,
      p_auto_fulfilled: true,
    })
    if (error) return { status: "error", error: error.message }
    return { status: "fulfilled", wmsOrderId }
  }

  // Still open: promote once payment has cleared, otherwise keep holding.
  if (order.paid) {
    const { error } = await client.rpc("activate_pending_order", {
      p_order_id: wmsOrderId,
    })
    if (error) return { status: "error", error: error.message }
    return { status: "activated", wmsOrderId }
  }
  return { status: "noop", reason: "still pending payment" }
}
