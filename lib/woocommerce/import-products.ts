import type { SupabaseClient } from "@supabase/supabase-js"

import { parseWeightGrams, stripWeightSuffix } from "../catalog/weight"
import {
  wooCost,
  wooVariantName,
  type WooProduct,
  type WooVariation,
} from "./types"

export type WooImportResult = {
  created: number
  updated: number
  skipped: number
  stockSynced: number
  costSeeded: number
  firstError?: string
}

export type WooImportOptions = {
  // Full variation objects for a variable product, pulled from
  // /products/{id}/variations. Absent on the webhook path (which carries only
  // variation ids), so variable products are skipped there.
  variations?: WooVariation[]
  // When true, push each unit's stock_quantity into WMS on_hand.
  syncInventory?: boolean
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** Price: prefer the regular price, fall back to the active price, else 0. */
function priceOf(regular: unknown, active: unknown): number {
  return num(regular) ?? num(active) ?? 0
}

/** Stock to sync, or null when the unit doesn't manage stock. */
function stockOf(
  manageStock: boolean | null | undefined,
  qty: unknown,
  syncInventory: boolean | undefined,
): number | null {
  if (!syncInventory || !manageStock) return null
  const n = num(qty)
  return n === null ? null : Math.trunc(n)
}

/**
 * Map one Woo product to WMS product(s) + child SKU(s) at a site, via the
 * idempotent upsert_store_variant RPC (channel = 'woocommerce'). Cost is never
 * sent (Woo core has none; WMS owns cost).
 *
 *   simple   -> one child SKU keyed by the product id
 *   variable -> one child SKU per provided variation, keyed by the variation id
 *               (opts.variations must be supplied; the webhook payload alone
 *               carries only variation ids, so variable products are skipped
 *               there and picked up by a product sync)
 */
export async function importWooProduct(
  client: SupabaseClient,
  siteId: string,
  product: WooProduct,
  opts: WooImportOptions = {},
): Promise<WooImportResult> {
  const res: WooImportResult = {
    created: 0,
    updated: 0,
    skipped: 0,
    stockSynced: 0,
    costSeeded: 0,
  }

  const upsert = async (
    storeVariantId: string,
    name: string,
    sku: string | null,
    price: number,
    cost: number | null,
    invQty: number | null,
    // Woo variations are addressed for OUTBOUND stock writes (migration 0026) as
    // /products/{parent}/variations/{id}, so a variation needs its parent
    // product id. Null for simple products (addressed by store_variant_id alone).
    parentId: string | null = null,
    // When the variation is a recognized weight, attach it to this strain parent
    // as a weight variant (grams) instead of a flattened "Strain - 3.5g" product.
    grams: number | null = null,
    strainName: string | null = null,
  ) => {
    const { data, error } =
      grams != null && strainName
        ? await client.rpc("upsert_store_weight_variant", {
            p_site_id: siteId,
            p_store_variant_id: storeVariantId,
            p_strain_name: strainName,
            p_grams_per_unit: grams,
            p_sku: sku,
            p_price: price,
            p_cost: cost,
            p_inventory_qty: invQty,
            p_channel: "woocommerce",
          })
        : await client.rpc("upsert_store_variant", {
            p_site_id: siteId,
            p_store_variant_id: storeVariantId,
            p_name: name,
            p_sku: sku,
            p_price: price,
            p_cost: cost,
            p_inventory_qty: invQty,
            p_channel: "woocommerce",
          })
    if (error) {
      res.skipped++
      if (!res.firstError) res.firstError = error.message
      return
    }
    const row = Array.isArray(data) ? data[0] : data
    if (row?.created) res.created++
    else res.updated++
    if (row?.cost_seeded) res.costSeeded++
    if (invQty != null) res.stockSynced++

    // Best-effort: record the parent id so outbound pushes can address the
    // variation. A failure here must not fail the catalog import.
    if (parentId && row?.child_sku_id) {
      await client
        .from("child_skus")
        .update({ store_parent_id: parentId })
        .eq("id", row.child_sku_id)
    }
  }

  const isVariable =
    (product.type ?? "").toLowerCase() === "variable" ||
    (product.variations?.length ?? 0) > 0 ||
    (opts.variations?.length ?? 0) > 0

  if (!isVariable) {
    const productId = product.id != null ? String(product.id) : null
    if (!productId) {
      res.skipped++
      return res
    }
    await upsert(
      productId,
      (product.name ?? "").trim() || "Untitled product",
      product.sku ?? null,
      priceOf(product.regular_price, product.price),
      wooCost(product.meta_data),
      stockOf(product.manage_stock, product.stock_quantity, opts.syncInventory),
    )
    return res
  }

  // Variable product: needs full variation objects (from a REST pull).
  const variations = opts.variations ?? []
  if (variations.length === 0) {
    res.skipped++ // can't map from variation ids alone; a product sync resolves it
    return res
  }
  for (const v of variations) {
    const variationId = v.id != null ? String(v.id) : null
    if (!variationId) {
      res.skipped++
      continue
    }
    const attrText = (v.attributes ?? [])
      .map((a) => (a.option ?? "").trim())
      .filter(Boolean)
      .join(" ")
    const grams = parseWeightGrams(attrText, v.sku)
    // Strip any trailing weight from the product name so per-weight products
    // group under one clean strain parent instead of stamping the weight onto
    // the grouping parent's name (which then mismatches its other-weight kids).
    const rawName = (product.name ?? "").trim()
    const strainName =
      stripWeightSuffix(rawName).strain || rawName || "Untitled product"
    await upsert(
      variationId,
      wooVariantName(product.name, v.attributes),
      v.sku ?? null,
      priceOf(v.regular_price, v.price),
      wooCost(v.meta_data),
      stockOf(v.manage_stock, v.stock_quantity, opts.syncInventory),
      product.id != null ? String(product.id) : null,
      grams,
      strainName,
    )
  }
  return res
}

/** Deactivate child SKUs for a deleted Woo product (simple id + any variations). */
export async function deactivateWooProduct(
  client: SupabaseClient,
  siteId: string,
  product: WooProduct,
): Promise<number> {
  const ids: string[] = []
  if (product.id != null) ids.push(String(product.id))
  for (const vid of product.variations ?? []) ids.push(String(vid))
  if (ids.length === 0) return 0

  const { data } = await client
    .from("child_skus")
    .update({ is_active: false })
    .eq("site_id", siteId)
    .in("store_variant_id", ids)
    .select("id")
  return data?.length ?? 0
}
