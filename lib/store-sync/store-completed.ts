import type { SupabaseClient } from "@supabase/supabase-js"

/**
 * Record that the source store marked an order completed/fulfilled — WITHOUT
 * changing OT status or touching inventory. This is what lets a store-completed
 * order surface in OT (a "Completed at store" badge) while staying `created` for
 * the team to pack and fulfil by hand, instead of needing a manual reconcile.
 *
 * Idempotent: only stamps when not already set, so a re-delivered webhook or the
 * nightly safety-net sweep is a harmless no-op. Must be called with a
 * service-role client (webhook / cron); the UI never writes this column.
 */
export async function markStoreCompleted(
  client: SupabaseClient,
  wmsOrderId: string,
  at: string | null,
): Promise<{ marked: boolean; error?: string }> {
  const { error } = await client
    .from("orders")
    .update({ store_completed_at: at ?? new Date().toISOString() })
    .eq("id", wmsOrderId)
    .is("store_completed_at", null)
  if (error) return { marked: false, error: error.message }
  return { marked: true }
}
