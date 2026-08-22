import type { SupabaseClient } from "@supabase/supabase-js"

/**
 * Record that an order shipped at the store/ShipStation AFTER it was already
 * cancelled in OT — WITHOUT changing status or touching inventory. Fed by two
 * independent detectors: the real-time webhook path (a later "shipped" event
 * arriving for an order already cancelled) and the scheduled ShipStation
 * cross-check sweep (catches the case where the store never re-fires a webhook
 * at all). Surfaces a review banner on the order so fulfilling it via
 * fulfill_cancelled_order doesn't depend on someone remembering to run the
 * ShipStation alignment check by hand.
 *
 * Idempotent: only stamps when not already set, so a re-delivered webhook or a
 * later sweep pass is a harmless no-op. Service-role client required.
 */
export async function flagShipConflict(
  client: SupabaseClient,
  wmsOrderId: string,
  note: string,
): Promise<{ flagged: boolean; error?: string }> {
  const { error } = await client
    .from("orders")
    .update({ ship_conflict_at: new Date().toISOString(), ship_conflict_note: note })
    .eq("id", wmsOrderId)
    .is("ship_conflict_at", null)
  if (error) return { flagged: false, error: error.message }
  return { flagged: true }
}
