import type { SupabaseClient } from "@supabase/supabase-js"

import { parseWeightGrams, stripWeightSuffix } from "../catalog/weight"
import { deactivateChildlessProducts } from "../store-sync/deactivate"
import { variantProductName, type ShopifyProduct } from "./types"

export type ProductImportResult = {
  created: number
  updated: number
  skipped: number
  costSeeded: number
  stockSynced: number
  firstError?: string
}

export type ImportOptions = {
  // inventory_item_id (string) -> unit cost, gathered from the Admin API.
  costByInventoryItemId?: Map<string, number>
  // When true, push each variant's available quantity into WMS on_hand.
  syncInventory?: boolean
}

/**
 * Map every variant of one Shopify product to a WMS product + child SKU at the
 * given site, via the idempotent upsert_store_variant RPC. Works with either
 * an end-user client (RLS applies) or the service-role client (webhook).
 *
 * Cost and inventory are only sent when opts provides them, so the webhook
 * product path (no opts) keeps its original name/price/sku-only behaviour.
 */
export async function importShopifyProduct(
  client: SupabaseClient,
  siteId: string,
  product: ShopifyProduct,
  opts: ImportOptions = {},
): Promise<ProductImportResult> {
  const res: ProductImportResult = {
    created: 0,
    updated: 0,
    skipped: 0,
    costSeeded: 0,
    stockSynced: 0,
  }

  for (const v of product.variants ?? []) {
    const variantId = v.id != null ? String(v.id) : null
    if (!variantId) {
      res.skipped++
      continue
    }
    const price = v.price != null ? Number(v.price) : 0

    // Cost from the InventoryItem lookup (the RPC seeds it only when unset).
    let cost: number | null = null
    const invItemId =
      v.inventory_item_id != null ? String(v.inventory_item_id) : null
    if (invItemId && opts.costByInventoryItemId?.has(invItemId)) {
      const c = opts.costByInventoryItemId.get(invItemId)!
      if (Number.isFinite(c)) cost = c
    }

    // Available quantity (requires read_inventory; may be absent).
    let invQty: number | null = null
    if (
      opts.syncInventory &&
      v.inventory_quantity != null &&
      Number.isFinite(Number(v.inventory_quantity))
    ) {
      invQty = Math.trunc(Number(v.inventory_quantity))
    }

    // If the variant title (or SKU) names a known weight, attach it to the
    // strain parent as a weight variant instead of a flattened "Strain - 3.5g".
    const grams = parseWeightGrams(v.title, v.sku)
    // Strip any trailing weight from the product title so per-weight store
    // products ("Blue Slushie - Indica - 28G") group under one clean strain
    // parent ("Blue Slushie - Indica") instead of stamping the weight onto the
    // grouping parent's name (which then mismatches its other-weight children).
    const rawTitle = (product.title ?? "").trim()
    const strainName =
      stripWeightSuffix(rawTitle).strain || rawTitle || "Untitled product"
    const { data, error } =
      grams != null
        ? await client.rpc("upsert_store_weight_variant", {
            p_site_id: siteId,
            p_store_variant_id: variantId,
            p_strain_name: strainName,
            p_grams_per_unit: grams,
            p_sku: v.sku ?? null,
            p_price: Number.isFinite(price) ? price : 0,
            p_cost: cost,
            p_inventory_qty: invQty,
            p_channel: "shopify",
          })
        : await client.rpc("upsert_store_variant", {
            p_site_id: siteId,
            p_store_variant_id: variantId,
            p_name: variantProductName(product.title, v.title),
            p_sku: v.sku ?? null,
            p_price: Number.isFinite(price) ? price : 0,
            p_cost: cost,
            p_inventory_qty: invQty,
            p_channel: "shopify",
          })
    if (error) {
      res.skipped++
      if (!res.firstError) res.firstError = error.message
      continue
    }
    const row = Array.isArray(data) ? data[0] : data
    if (row?.created) res.created++
    else res.updated++
    if (row?.cost_seeded) res.costSeeded++
    if (invQty != null) res.stockSynced++

    // Persist the InventoryItem id so OUTBOUND stock pushes (migration 0026)
    // can address this variant's stock. Best-effort: a failure here must not
    // fail the catalog import.
    if (invItemId && row?.child_sku_id) {
      await client
        .from("child_skus")
        .update({ store_inventory_item_id: invItemId })
        .eq("id", row.child_sku_id)
    }
  }

  return res
}

/**
 * Deactivate the child SKUs for a deleted Shopify product (keeps history), then
 * deactivate any parent product left with no active children so a store-deleted
 * product doesn't linger as active. Returns both counts.
 */
export async function deactivateShopifyProduct(
  client: SupabaseClient,
  siteId: string,
  product: ShopifyProduct,
): Promise<{ childSkus: number; products: number }> {
  const variantIds = (product.variants ?? [])
    .map((v) => (v.id != null ? String(v.id) : null))
    .filter((v): v is string => Boolean(v))
  if (variantIds.length === 0) return { childSkus: 0, products: 0 }

  const { data } = await client
    .from("child_skus")
    .update({ is_active: false })
    .eq("site_id", siteId)
    .in("store_variant_id", variantIds)
    .select("id, product_id")

  const products = await deactivateChildlessProducts(
    client,
    (data ?? []).map((r) => r.product_id as string | null),
  )
  return { childSkus: data?.length ?? 0, products }
}
