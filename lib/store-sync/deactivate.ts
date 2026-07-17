import type { SupabaseClient } from "@supabase/supabase-js"

// ---------------------------------------------------------------------------
// Cross-channel catalog cleanup for store deletes.
//
// When a store product is deleted, the channel importer deactivates that
// product's CHILD SKUs (by store_variant_id). This helper then walks the
// affected PARENT products and deactivates any that have no active child SKUs
// left, so a store-deleted product doesn't linger as "active" in the catalog.
//
// Multi-site / multi-store safe: a parent still sold at another site or store
// keeps at least one active child, so it stays active. Reversible: a resync or
// a manual toggle reactivates the parent (a later store event that re-adds a
// child also flips is_active back on via upsert_store_variant).
// ---------------------------------------------------------------------------

/**
 * Deactivate any of the given parent products that now have zero active child
 * SKUs. Returns how many parents were flipped. Best-effort and idempotent:
 * only currently-active parents are touched, and a failure must not fail the
 * caller's delete webhook (callers should not let this throw the request).
 */
export async function deactivateChildlessProducts(
  client: SupabaseClient,
  productIds: (string | null | undefined)[],
): Promise<number> {
  const ids = [...new Set(productIds.filter((id): id is string => Boolean(id)))]
  if (ids.length === 0) return 0

  let deactivated = 0
  for (const productId of ids) {
    // Count child SKUs still active under this parent. head:true fetches only
    // the count, not the rows.
    const { count, error: countErr } = await client
      .from("child_skus")
      .select("id", { count: "exact", head: true })
      .eq("product_id", productId)
      .eq("is_active", true)
    if (countErr) continue
    if ((count ?? 0) > 0) continue // still sold somewhere — leave it active

    // Flip only if currently active, so the returned rows are an accurate count
    // of parents this call actually changed.
    const { data } = await client
      .from("products")
      .update({ is_active: false })
      .eq("id", productId)
      .eq("is_active", true)
      .select("id")
    if (data && data.length > 0) deactivated++
  }
  return deactivated
}
