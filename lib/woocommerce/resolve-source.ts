import type { SupabaseClient } from "@supabase/supabase-js"

/**
 * Map an incoming (already normalized) Woo webhook source to the canonical
 * store_connections.source it belongs to. A connection matches on its own
 * `source` or any entry in `source_aliases` (e.g. Bud Club answers to both
 * budclubshop.com and budclub.com). Everything downstream — secret lookup,
 * order import idempotency key, lifecycle updates — then runs on the canonical
 * source, so both domains share one history.
 *
 * Falls back to the incoming source unchanged when nothing matches, or when the
 * lookup fails (e.g. the source_aliases column isn't migrated yet), so this can
 * never make a previously-working exact match stop working.
 */
export async function resolveWooSource(
  supabase: SupabaseClient,
  source: string,
): Promise<string> {
  if (!source) return source
  const { data, error } = await supabase
    .from("store_connections")
    .select("source, source_aliases")
    .eq("channel", "woocommerce")
    .eq("is_active", true)
  if (error || !data) return source

  const rows = data as { source: string; source_aliases: string[] | null }[]
  if (rows.some((r) => r.source === source)) return source
  const hit = rows.find((r) => (r.source_aliases ?? []).includes(source))
  return hit?.source ?? source
}
