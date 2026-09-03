import type { SupabaseClient } from "@supabase/supabase-js"

import { fetchAllPages } from "@/lib/supabase/fetch-all"

// ---------------------------------------------------------------------------
// "Weight conflict" definition — a store sync tried to change a child SKU's
// grams_per_unit to something different from what WMS already held. Migration
// 0108 refuses the write and records the attempt in store_weight_conflicts;
// this module decides which of those rows are still worth showing.
//
// A recorded row is OPEN when both hold:
//   1. it has not been dismissed (resolved_at is null), and
//   2. the child SKU STILL carries the weight the store disputed
//      (child_skus.grams_per_unit = wms_grams_per_unit).
//
// Condition 2 is what makes the warning self-clearing: correcting the weight in
// WMS — whichever way you decide — moves the child off the disputed value and
// the row stops being open, with nothing to remember to tick off. The row is
// kept, not deleted, so the history of what the store kept sending survives.
//
// The remaining case is "WMS is right and the store's naming will not change".
// That needs an explicit dismissal (resolved_at), since the store will keep
// sending the same disagreement on every sync.
// ---------------------------------------------------------------------------

export type OpenWeightConflict = {
  childSkuId: string
  productId: string
  siteId: string
  channel: string
  sku: string | null
  variantLabel: string | null
  wmsGrams: number
  storeGrams: number
  seenCount: number
  lastSeenAt: string
}

type ConflictRow = {
  child_sku_id: string
  site_id: string
  channel: string
  wms_grams_per_unit: number | string
  store_grams_per_unit: number | string
  seen_count: number
  last_seen_at: string
  resolved_at: string | null
  child_sku: {
    product_id: string
    sku: string | null
    variant_label: string | null
    grams_per_unit: number | string | null
    is_active: boolean
  } | null
}

/**
 * Every open weight conflict the caller can see. RLS-scoped by the caller's
 * client, so a client manager sees only their own sites.
 */
export async function openWeightConflicts(
  supabase: SupabaseClient,
): Promise<OpenWeightConflict[]> {
  // Paged: a truncated scan silently shrinks the warning set, which is the same
  // failure that hid a second bad SKU during the 2026-09-03 investigation.
  const rows = await fetchAllPages<ConflictRow>(() =>
    supabase
      .from("store_weight_conflicts")
      .select(
        "child_sku_id, site_id, channel, wms_grams_per_unit, store_grams_per_unit, seen_count, last_seen_at, resolved_at, child_sku:child_skus(product_id, sku, variant_label, grams_per_unit, is_active)",
      )
      .is("resolved_at", null)
      .order("id"),
  )

  const open: OpenWeightConflict[] = []
  for (const r of rows) {
    const child = r.child_sku
    if (!child || !child.is_active) continue
    // Still disputed only while the child holds the weight the store objected
    // to. Any correction in WMS retires the row on its own.
    if (child.grams_per_unit == null) continue
    if (Number(child.grams_per_unit) !== Number(r.wms_grams_per_unit)) continue
    open.push({
      childSkuId: r.child_sku_id,
      productId: child.product_id,
      siteId: r.site_id,
      channel: r.channel,
      sku: child.sku,
      variantLabel: child.variant_label,
      wmsGrams: Number(r.wms_grams_per_unit),
      storeGrams: Number(r.store_grams_per_unit),
      seenCount: r.seen_count,
      lastSeenAt: r.last_seen_at,
    })
  }
  return open
}

/** Parent product ids carrying at least one open weight conflict. */
export async function weightConflictParentIds(
  supabase: SupabaseClient,
): Promise<string[]> {
  const open = await openWeightConflicts(supabase)
  return [...new Set(open.map((c) => c.productId))]
}
