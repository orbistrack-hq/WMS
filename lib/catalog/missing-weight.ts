import type { SupabaseClient } from "@supabase/supabase-js"

// ---------------------------------------------------------------------------
// "Missing weight" definition — shared by the catalog warning, the packing
// queue/wave badges, the pack screen banner, and the packaging-gaps report so
// every surface agrees on what counts.
//
// A child SKU is missing its weight when it's active and carries neither a
// grams_per_unit nor a variant_label (a null weight WITH a label like "Ounce
// Special" is an intentional non-weight variant, not a gap).
//
// But not every product sells by weight, and a single-child product often
// legitimately has no weight — flagging those is just noise. So we only warn on
// a no-weight child when its PARENT product carries at least
// MIN_CHILDREN_FOR_WEIGHT child SKUs, which is the observed pattern for
// weight-variant products in the stores. This is a heuristic, deliberately kept
// in one place so it's easy to change (or replace with an explicit
// "sold by weight" flag) later.
// ---------------------------------------------------------------------------

export const MIN_CHILDREN_FOR_WEIGHT = 2

type ChildWeightRow = {
  is_active: boolean
  grams_per_unit: number | string | null
  variant_label: string | null
}

/** True when this child SKU is active and has no weight and no variant label. */
export function isMissingWeight(c: ChildWeightRow): boolean {
  return c.is_active && c.grams_per_unit == null && !c.variant_label
}

/** Whether a product's child SKUs make it a weight-variant product worth warning about. */
export function qualifiesForWeightWarning(childCount: number): boolean {
  return childCount >= MIN_CHILDREN_FOR_WEIGHT
}

/**
 * Count child SKUs per parent product for the given product ids. RLS-scoped by
 * the caller's client, so counts match what that user can see. Returns a Map
 * keyed by product id; ids with no children are simply absent.
 */
export async function childCountsByParent(
  supabase: SupabaseClient,
  productIds: string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>()
  if (productIds.length === 0) return counts
  const { data } = await supabase
    .from("child_skus")
    .select("product_id")
    .in("product_id", productIds)
  for (const r of (data ?? []) as { product_id: string }[])
    counts.set(r.product_id, (counts.get(r.product_id) ?? 0) + 1)
  return counts
}

/**
 * Product ids that (a) have at least one active child SKU with no weight and no
 * label, AND (b) carry at least MIN_CHILDREN_FOR_WEIGHT child SKUs total. This
 * is the set of parents the catalog warns on. RLS-scoped by the client.
 */
export async function missingWeightParentIds(
  supabase: SupabaseClient,
): Promise<string[]> {
  const { data: missingRows } = await supabase
    .from("child_skus")
    .select("product_id")
    .eq("is_active", true)
    .is("grams_per_unit", null)
    .is("variant_label", null)
  const candidates = [
    ...new Set(
      ((missingRows ?? []) as { product_id: string }[]).map(
        (r) => r.product_id,
      ),
    ),
  ]
  if (candidates.length === 0) return []
  const counts = await childCountsByParent(supabase, candidates)
  return candidates.filter((id) => qualifiesForWeightWarning(counts.get(id) ?? 0))
}
