import { createAdminClient } from "@/lib/supabase/admin"

import { kickOutboundDrain } from "./outbound"

/**
 * Outbound inventory RECONCILE (migration 0093) — the backfill half of the
 * outbound queue.
 *
 * WHY THIS EXISTS
 * The enqueue trigger (migration 0026) decides at the moment stock moves, and
 * it needs three things to already be true: the child SKU is mapped
 * (store_variant_id), the site has a connection that is is_active, and that
 * connection has sync_inventory_outbound on. Miss any one and the trigger
 * returns silently — no job, no error, nothing in the Skipped counter.
 *
 * That's exactly the shape of a store that isn't finished being wired up:
 * webhooks never registered, products not synced yet, outbound flag still at
 * its FALSE default. Allocate inventory to that site and the movement is simply
 * never queued, and flipping the store on afterwards used to change nothing —
 * draining an empty queue pushes nothing, so the storefront kept showing stale
 * stock until some unrelated future movement happened to touch the same SKU.
 *
 * Reconcile closes that: it enqueues one job per mapped SKU on the site from
 * current inventory_levels, so "turn the store on" converges the storefront on
 * WMS truth instead of only catching what happens next. It also gives SKUs
 * whose earlier job went terminal ('skipped' on a bad mapping, 'failed' after
 * the attempt cap) a fresh pending row — the supported retry once the cause is
 * fixed.
 *
 * Idempotent by construction: the RPC upserts against the one-pending-per-SKU
 * index, and pushes SET an absolute available, so running it twice is harmless.
 *
 * The RPC is sealed to service_role, so callers must authorize the user FIRST
 * and then call these with the admin client — same contract as the drain.
 */

export type ReconcileResult = {
  /** Jobs enqueued or refreshed. 0 also means "site has no enabled connection". */
  enqueued: number
  error?: string
}

/**
 * Reconcile one site's outbound queue. Never throws — a reconcile failure must
 * not break the action that triggered it (enabling a store, activating a
 * connection); the worst case is the pre-0093 behaviour we already lived with.
 */
export async function reconcileOutboundForSite(
  siteId: string | null | undefined,
): Promise<ReconcileResult> {
  if (!siteId) return { enqueued: 0 }
  try {
    const admin = createAdminClient()
    const { data, error } = await admin.rpc("reconcile_outbound_inventory_for_site", {
      p_site_id: siteId,
    })
    if (error) return { enqueued: 0, error: error.message }
    return { enqueued: typeof data === "number" ? data : 0 }
  } catch (e) {
    return { enqueued: 0, error: e instanceof Error ? e.message : "reconcile failed" }
  }
}

/**
 * Reconcile a site, then immediately nudge the drain so the operator sees stock
 * land instead of waiting for the next scheduled run. The kick is time-bounded
 * and swallows its own errors (see kickOutboundDrain), and the scheduled drain
 * plus reaper remain the safety net for anything it doesn't get through.
 */
export async function reconcileAndDrainSite(
  siteId: string | null | undefined,
  drainLimit = 200,
  drainDeadlineMs = 15_000,
): Promise<ReconcileResult> {
  const result = await reconcileOutboundForSite(siteId)
  if (result.enqueued > 0) {
    await kickOutboundDrain(drainLimit, drainDeadlineMs)
  }
  return result
}
