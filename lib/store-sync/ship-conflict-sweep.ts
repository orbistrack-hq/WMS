import type { SupabaseClient } from "@supabase/supabase-js"

import { reconcileShipStation } from "@/lib/shipstation/reconcile"
import { flagShipConflict } from "./ship-conflict"

// ---------------------------------------------------------------------------
// Scheduled belt-and-suspenders for the cancelled-but-shipped drift: the
// real-time webhook flag (lib/woocommerce & lib/shopify import-orders.ts) only
// fires when the store re-sends a webhook after the order shipped. If the
// store's own status never flips (e.g. ShipStation ships an order without
// pushing completion back to the store), no webhook ever arrives to intercept
// — this sweep catches that case by cross-checking ShipStation directly, the
// same comparison the /integrations/shipstation screen already runs by hand.
// ---------------------------------------------------------------------------

export type ShipConflictSweepSummary = {
  candidates: number
  flagged: number
  errors: number
}

/**
 * Re-run the ShipStation ⇄ OT reconcile and flag any order it finds shipped in
 * ShipStation while still cancelled in OT (reconcileShipStation's
 * shippedNotFulfilled bucket, filtered to the cancelled case). Idempotent via
 * flagShipConflict — a repeat sweep pass over an already-flagged order is a
 * harmless no-op. Service-role client required.
 */
export async function sweepShipConflicts(
  admin: SupabaseClient,
  apiKey: string,
  apiSecret: string,
): Promise<ShipConflictSweepSummary> {
  const result = await reconcileShipStation(admin, apiKey, apiSecret, null)
  const candidates = result.shippedNotFulfilled.filter((r) =>
    r.note?.includes("cancelled"),
  )

  const summary: ShipConflictSweepSummary = {
    candidates: candidates.length,
    flagged: 0,
    errors: 0,
  }

  for (const row of candidates) {
    const { data: order, error } = await admin
      .from("orders")
      .select("id, ship_conflict_at")
      .eq("order_number", row.orderNumber)
      .maybeSingle()
    if (error || !order || order.ship_conflict_at) continue

    const res = await flagShipConflict(
      admin,
      order.id as string,
      `ShipStation shows this order shipped, but OT still shows cancelled (found by the scheduled alignment sweep).`,
    )
    if (res.flagged) summary.flagged++
    else summary.errors++
  }

  return summary
}
