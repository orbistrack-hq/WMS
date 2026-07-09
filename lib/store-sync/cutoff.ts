/**
 * Order-sync floor (store_connections.sync_orders_since).
 *
 * When a store goes live on WMS we do not want its historical orders pulled in.
 * Two paths can import an order: the past-orders backfill and the webhook
 * self-heal (orders/updated for an order we never imported falls through to an
 * import). Both run every candidate order through isBeforeSyncCutoff() so a
 * single floor governs them together — the backfill's created_at query filter is
 * only an optimization; this is the authoritative gate.
 *
 * Comparison is instant-based (parsed to epoch millis) so it is correct across
 * timezones: Shopify sends an offset ("…-04:00"), Woo sends a naive local stamp
 * ("2026-06-30T14:02:11"), and the cutoff is a Postgres timestamptz serialized
 * as ISO UTC. A naive Woo stamp is read as the runtime's local time — good to
 * day granularity, which is all a go-live floor needs.
 *
 * Fails OPEN: a null cutoff ("no floor") or an absent/unparseable createdAt
 * returns false (import it), so we never silently drop a real order over a
 * missing or malformed date. Boundary is inclusive — an order created exactly at
 * the cutoff is kept.
 */
export function isBeforeSyncCutoff(
  createdAt: string | null | undefined,
  cutoff: string | null | undefined,
): boolean {
  if (!cutoff) return false
  if (!createdAt) return false
  const created = Date.parse(createdAt)
  const floor = Date.parse(cutoff)
  if (Number.isNaN(created) || Number.isNaN(floor)) return false
  return created < floor
}

/**
 * Date portion (YYYY-MM-DD) of the cutoff for the store fetch query filters
 * (Shopify `created_at:>=`, Woo `after=`). Null when there is no floor.
 */
export function cutoffQueryDate(
  cutoff: string | null | undefined,
): string | null {
  if (!cutoff) return null
  const t = Date.parse(cutoff)
  if (Number.isNaN(t)) return null
  return new Date(t).toISOString().slice(0, 10)
}
