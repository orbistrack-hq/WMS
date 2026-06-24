import type { SupabaseClient } from "@supabase/supabase-js"

import { variantProductName, type ShopifyProduct } from "./types"

export type ProductImportResult = {
  created: number
  updated: number
  skipped: number
}

/**
 * Map every variant of one Shopify product to a WMS product + child SKU at the
 * given site, via the idempotent upsert_shopify_variant RPC. Works with either
 * an end-user client (RLS applies) or the service-role client (webhook).
 */
export async function importShopifyProduct(
  client: SupabaseClient,
  siteId: string,
  product: ShopifyProduct,
): Promise<ProductImportResult> {
  const res: ProductImportResult = { created: 0, updated: 0, skipped: 0 }

  for (const v of product.variants ?? []) {
    const variantId = v.id != null ? String(v.id) : null
    if (!variantId) {
      res.skipped++
      continue
    }
    const price = v.price != null ? Number(v.price) : 0
    const { data, error } = await client.rpc("upsert_shopify_variant", {
      p_site_id: siteId,
      p_store_variant_id: variantId,
      p_name: variantProductName(product.title, v.title),
      p_sku: v.sku ?? null,
      p_price: Number.isFinite(price) ? price : 0,
    })
    if (error) {
      res.skipped++
      continue
    }
    const row = Array.isArray(data) ? data[0] : data
    if (row?.created) res.created++
    else res.updated++
  }

  return res
}

/** Deactivate the child SKUs for a deleted Shopify product (keeps history). */
export async function deactivateShopifyProduct(
  client: SupabaseClient,
  siteId: string,
  product: ShopifyProduct,
): Promise<number> {
  const variantIds = (product.variants ?? [])
    .map((v) => (v.id != null ? String(v.id) : null))
    .filter((v): v is string => Boolean(v))
  if (variantIds.length === 0) return 0

  const { data } = await client
    .from("child_skus")
    .update({ is_active: false })
    .eq("site_id", siteId)
    .in("store_variant_id", variantIds)
    .select("id")
  return data?.length ?? 0
}
