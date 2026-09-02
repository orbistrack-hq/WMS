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
 * Parse an ISO-ish date-time's wall-clock digits (year..seconds), ignoring
 * any trailing offset/zone and fractional seconds, into a fake-UTC epoch.
 * Never mix this with a real epoch (e.g. from `Date.parse`) — it's only
 * meaningful as a DIFFERENCE against another value produced the same way.
 *
 * Why not `Date.parse`: WooCommerce's `date_created` has no offset, so
 * `Date.parse`/`new Date()` reads it as the RUNTIME's local zone (UTC on
 * Vercel) — not the store's zone. `entered_at` comes back from Postgres with
 * an explicit offset (session tz = America/Los_Angeles, migration 0049)
 * instead. Parsed with `Date.parse`, those two disagree by a fixed ~7-8h
 * (the Pacific/UTC offset) on EVERY comparison, even for the very same
 * order's own moment — which is exactly the false-positive this guarded
 * against. Comparing wall-clock digits directly sidesteps the mismatch
 * entirely: both sides are the store's local clock, so their digits line up
 * without needing to know what zone that clock is actually in.
 */
function wallClockEpoch(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(iso)
  if (!m) return null
  const [, y, mo, d, h, mi, s] = m
  return Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)
}

/**
 * Whether an incoming order's created-at date is far enough from the WMS
 * order already on file under the same external id to be a different order
 * rather than a re-delivery. Null (or unparseable) on either side means
 * "can't tell" — treated as no collision so a missing/malformed date doesn't
 * start false-flagging.
 */
export function isOrderIdCollision(
  existingEnteredAt: string | null,
  incomingCreatedAt: string | null,
): boolean {
  if (!existingEnteredAt || !incomingCreatedAt) return false
  const existing = wallClockEpoch(existingEnteredAt)
  const incoming = wallClockEpoch(incomingCreatedAt)
  if (existing === null || incoming === null) return false
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
