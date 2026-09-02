import type { SupabaseClient } from "@supabase/supabase-js"

// ---------------------------------------------------------------------------
// A store re-used an external_order_id WMS already has on file for a
// DIFFERENT order (seen on WooCommerce's budclub store after its order-id
// counter reset, apparently from a database restore during a domain
// migration). The (channel, source, external_order_id) idempotency key can't
// tell "the same order, re-delivered" from "a different order, reused
// number" — so instead of guessing, this records the mismatch and the caller
// skips mutating the existing order. See migration 0107.
// ---------------------------------------------------------------------------

/** Anything wider than this between the incoming and on-file dates is a
 *  different order, not clock skew or a re-delivery. */
const COLLISION_THRESHOLD_MS = 5 * 60 * 1000

/**
 * Whether an incoming order's created-at date is far enough from the WMS
 * order already on file under the same external id to be a different order
 * rather than a re-delivery. Null on either side means "can't tell" — treated
 * as no collision so an order lacking a stored/incoming date doesn't start
 * false-flagging.
 */
export function isOrderIdCollision(
  existingEnteredAt: string | null,
  incomingCreatedAt: string | null,
): boolean {
  if (!existingEnteredAt || !incomingCreatedAt) return false
  const existing = Date.parse(existingEnteredAt)
  const incoming = Date.parse(incomingCreatedAt)
  if (Number.isNaN(existing) || Number.isNaN(incoming)) return false
  return Math.abs(existing - incoming) > COLLISION_THRESHOLD_MS
}

/**
 * Record a detected collision. Best-effort: a failure here must never block
 * the caller from safely no-op'ing on the existing order — that skip is the
 * actual safety property; this row is just the visibility into it.
 */
export async function flagOrderIdCollision(
  client: SupabaseClient,
  params: {
    channel: string
    source: string
    externalOrderId: string
    siteId: string
    existingWmsOrderId: string
    existingEnteredAt: string | null
    incomingCreatedAt: string | null
    incomingPayload: unknown
    note: string
  },
): Promise<void> {
  const { error } = await client.from("store_order_import_collisions").insert({
    channel: params.channel,
    source: params.source,
    external_order_id: params.externalOrderId,
    site_id: params.siteId,
    existing_wms_order_id: params.existingWmsOrderId,
    existing_entered_at: params.existingEnteredAt,
    incoming_created_at: params.incomingCreatedAt,
    incoming_payload: params.incomingPayload,
    note: params.note,
  })
  if (error) {
    console.error(
      `[order-id-collision] failed to record ${params.channel}/${params.source}#${params.externalOrderId}: ${error.message}`,
    )
  }
}
