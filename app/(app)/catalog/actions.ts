"use server"

import { revalidatePath } from "next/cache"

import { createClient } from "@/lib/supabase/server"
import { descendantIds, type CategoryRow } from "@/lib/catalog/types"

export type ActionResult<T = unknown> =
  | ({ ok: true } & T)
  | { ok: false; error: string }

type PgError = {
  message?: string
  details?: string
  code?: string
} | null

/** Turn a PostgREST/Postgres error into something an operator can act on. */
function dbError(error: PgError, context?: Record<string, string>): string {
  if (!error) return "Something went wrong."
  const hay = `${error.message ?? ""} ${error.details ?? ""}`
  if (error.code === "23505") {
    if (context) {
      for (const [needle, msg] of Object.entries(context)) {
        if (hay.includes(needle)) return msg
      }
    }
    return "A matching record already exists."
  }
  if (error.code === "23503")
    return "This record is still referenced elsewhere and can't be changed."
  if (error.code === "42501")
    return "You don't have permission to do that."
  return error.message || error.details || "Something went wrong."
}

function revalidateCatalog(productId?: string) {
  revalidatePath("/catalog")
  if (productId) revalidatePath(`/catalog/${productId}`)
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------
export type ProductInput = {
  name: string
  /** WMS-only parent SKU code (e.g. "AF"), shown alongside the name (FB-8). */
  sku?: string | null
  description?: string | null
  category_id?: string | null
  is_active?: boolean
}

export async function createProduct(
  input: ProductInput,
): Promise<ActionResult<{ productId: string }>> {
  if (!input.name?.trim()) return { ok: false, error: "Name is required." }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from("products")
    .insert({
      name: input.name.trim(),
      sku: input.sku?.trim() || null,
      description: input.description?.trim() || null,
      category_id: input.category_id || null,
      is_active: input.is_active ?? true,
    })
    .select("id")
    .single()

  if (error) return { ok: false, error: dbError(error) }
  revalidateCatalog()
  return { ok: true, productId: data.id as string }
}

export async function updateProduct(
  id: string,
  input: ProductInput,
): Promise<ActionResult> {
  if (!input.name?.trim()) return { ok: false, error: "Name is required." }

  const supabase = await createClient()
  const { error } = await supabase
    .from("products")
    .update({
      name: input.name.trim(),
      sku: input.sku?.trim() || null,
      description: input.description?.trim() || null,
      category_id: input.category_id || null,
      is_active: input.is_active ?? true,
    })
    .eq("id", id)

  if (error) return { ok: false, error: dbError(error) }
  revalidateCatalog(id)
  return { ok: true }
}

/**
 * Update only the parent SKU code (FB-8) — used by the inline editor on
 * /inventory/by-parent, where renaming/other product fields aren't in play.
 * Empty string clears the code. WMS-only; store sync never touches this column.
 */
export async function updateProductSku(
  id: string,
  sku: string | null,
): Promise<ActionResult> {
  if (!id) return { ok: false, error: "No product specified." }

  const supabase = await createClient()
  const { error } = await supabase
    .from("products")
    .update({ sku: sku?.trim() || null })
    .eq("id", id)

  if (error) return { ok: false, error: dbError(error) }
  revalidateCatalog(id)
  revalidatePath("/inventory/by-parent")
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Child SKUs (one product at one site, per weight variant)
// ---------------------------------------------------------------------------
// A product can now have several child SKUs at the same site — one per weight
// variant (e.g. 3.5g / 7g / 14g / 28g) plus at most one non-weight child. The
// DB enforces uniqueness on (product_id, site_id, coalesce(grams_per_unit, -1)).
export type ChildSkuInput = {
  product_id: string
  site_id: string
  sku?: string | null
  store_variant_id?: string | null
  bin_location?: string | null
  barcode?: string | null
  /** Sellable weight per unit in grams (3.5, 7, …). Null = non-weight child. */
  grams_per_unit?: number | null
  /** Display label for the variant, e.g. "3.5g". Derived from grams if blank. */
  variant_label?: string | null
  price: number
  cost: number
  is_active?: boolean
}

const SKU_CONFLICTS = {
  child_skus_pkey: "This product already has this SKU.",
  child_skus_product_site_variant_key:
    "This product already has a SKU of that weight at this site.",
  child_skus_site_sku_key: "That SKU code is already used at this site.",
}

/** Normalize an optional grams input; blank/invalid becomes null. */
function normalizeGrams(g: number | null | undefined): number | null {
  if (g == null || Number.isNaN(g) || g <= 0) return null
  return g
}

/** Label a variant: explicit text wins, else derive "<grams>g", else null. */
function weightLabel(
  grams: number | null,
  explicit?: string | null,
): string | null {
  const e = explicit?.trim()
  if (e) return e
  return grams == null ? null : `${grams}g`
}

export async function createChildSku(
  input: ChildSkuInput,
): Promise<ActionResult> {
  if (!input.site_id) return { ok: false, error: "Pick a site." }
  if (!(input.price >= 0) || !(input.cost >= 0))
    return { ok: false, error: "Price and cost must be zero or more." }

  const grams = normalizeGrams(input.grams_per_unit)
  const supabase = await createClient()
  const { error } = await supabase.from("child_skus").insert({
    product_id: input.product_id,
    site_id: input.site_id,
    sku: input.sku?.trim() || null,
    store_variant_id: input.store_variant_id?.trim() || null,
    bin_location: input.bin_location?.trim() || null,
    barcode: input.barcode?.trim() || null,
    grams_per_unit: grams,
    variant_label: weightLabel(grams, input.variant_label),
    price: input.price,
    cost: input.cost,
    is_active: input.is_active ?? true,
  })

  if (error) return { ok: false, error: dbError(error, SKU_CONFLICTS) }
  revalidateCatalog(input.product_id)
  return { ok: true }
}

export async function updateChildSku(
  id: string,
  productId: string,
  input: Omit<ChildSkuInput, "product_id" | "site_id">,
): Promise<ActionResult> {
  if (!(input.price >= 0) || !(input.cost >= 0))
    return { ok: false, error: "Price and cost must be zero or more." }

  const grams = normalizeGrams(input.grams_per_unit)
  const supabase = await createClient()
  const { error } = await supabase
    .from("child_skus")
    .update({
      sku: input.sku?.trim() || null,
      store_variant_id: input.store_variant_id?.trim() || null,
      bin_location: input.bin_location?.trim() || null,
      barcode: input.barcode?.trim() || null,
      grams_per_unit: grams,
      variant_label: weightLabel(grams, input.variant_label),
      price: input.price,
      cost: input.cost,
      is_active: input.is_active ?? true,
    })
    .eq("id", id)

  if (error) return { ok: false, error: dbError(error, SKU_CONFLICTS) }
  revalidateCatalog(productId)
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Re-parenting a child SKU (manual product mapping)
// ---------------------------------------------------------------------------
// Moves a child SKU from one master product to another — the manual counterpart
// to the SKU-based auto-attach the Shopify sync does. Guarded by the schema's
// uniqueness rule (product_id, site_id, coalesce(grams_per_unit, -1)): if the
// destination already owns a SKU of the SAME weight at this child's site, the
// two must be MERGED instead, so we stop with a clear message rather than erroring.

export type ProductSearchResult = {
  id: string
  name: string
  is_active: boolean
  /** Number of sites this product already has a SKU at. */
  site_count: number
  /** SKU codes across sites, for disambiguating same-named products. */
  skus: string[]
}

/** Search master products by name, for the re-parent picker. */
export async function searchProducts(
  query: string,
  excludeProductId?: string,
): Promise<ActionResult<{ products: ProductSearchResult[] }>> {
  const supabase = await createClient()

  let q = supabase
    .from("products")
    .select("id, name, is_active, child_skus(sku)")
    .order("name")
    .limit(20)

  const trimmed = query.trim()
  if (trimmed) q = q.ilike("name", `%${trimmed}%`)
  if (excludeProductId) q = q.neq("id", excludeProductId)

  const { data, error } = await q
  if (error) return { ok: false, error: dbError(error) }

  const rows = (data ?? []) as {
    id: string
    name: string
    is_active: boolean
    child_skus: { sku: string | null }[] | null
  }[]

  const products: ProductSearchResult[] = rows.map((p) => {
    const children = p.child_skus ?? []
    return {
      id: p.id,
      name: p.name,
      is_active: p.is_active,
      site_count: children.length,
      skus: children
        .map((c) => c.sku)
        .filter((s): s is string => Boolean(s)),
    }
  })

  return { ok: true, products }
}

/** Move a child SKU to a different master product. */
export async function reparentChildSku(
  childSkuId: string,
  fromProductId: string,
  toProductId: string,
): Promise<ActionResult> {
  if (!toProductId) return { ok: false, error: "Pick a destination product." }
  if (toProductId === fromProductId)
    return { ok: false, error: "That SKU is already on this product." }

  const supabase = await createClient()

  // Read the child's site + weight so we can give a precise conflict message.
  const { data: child, error: childErr } = await supabase
    .from("child_skus")
    .select("id, site_id, grams_per_unit, site:sites(name)")
    .eq("id", childSkuId)
    .maybeSingle()
  if (childErr) return { ok: false, error: dbError(childErr) }
  if (!child) return { ok: false, error: "That SKU no longer exists." }

  // Confirm the destination product still exists.
  const { data: target, error: targetErr } = await supabase
    .from("products")
    .select("id, name")
    .eq("id", toProductId)
    .maybeSingle()
  if (targetErr) return { ok: false, error: dbError(targetErr) }
  if (!target) return { ok: false, error: "That product no longer exists." }

  // Uniqueness guard: destination must not already own a SKU of the SAME weight
  // at this child's site. If it does, the right operation is a merge, not a move.
  const childRow = child as unknown as {
    site_id: string
    grams_per_unit: number | string | null
    site: { name: string | null } | null
  }
  const childGrams =
    childRow.grams_per_unit == null ? null : Number(childRow.grams_per_unit)
  let clashQuery = supabase
    .from("child_skus")
    .select("id")
    .eq("product_id", toProductId)
    .eq("site_id", childRow.site_id)
  clashQuery =
    childGrams == null
      ? clashQuery.is("grams_per_unit", null)
      : clashQuery.eq("grams_per_unit", childGrams)
  const { data: clash, error: clashErr } = await clashQuery.maybeSingle()
  if (clashErr) return { ok: false, error: dbError(clashErr) }
  if (clash) {
    const siteName = childRow.site?.name ?? "this site"
    const weight = childGrams == null ? "a SKU" : `a ${childGrams}g SKU`
    return {
      ok: false,
      error: `"${target.name}" already has ${weight} at ${siteName}. Merge the products instead of moving this SKU.`,
    }
  }

  const { error } = await supabase
    .from("child_skus")
    .update({ product_id: toProductId })
    .eq("id", childSkuId)
  if (error) return { ok: false, error: dbError(error, SKU_CONFLICTS) }

  // Both detail pages change: the source loses a SKU, the destination gains one.
  revalidateCatalog(fromProductId)
  revalidatePath(`/catalog/${toProductId}`)
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Merging products (manual consolidation of duplicate masters)
// ---------------------------------------------------------------------------
// Thin wrapper over the merge_products RPC. The RPC does the work and the
// safety (operator-only, site access, one-child-per-site conflict guard). We
// run it once in dry-run to preview, then for real to commit.

export type MergeConflict = {
  site_id: string
  site_name: string | null
  skus: string[]
}

export type MergePreview = {
  ok: boolean
  /** Child SKUs that would move onto the survivor. */
  moved: number
  /** Sites where survivor + a loser both hold a SKU — block the merge. */
  conflicts: MergeConflict[]
}

type MergeRpcResult = {
  ok: boolean
  dry_run: boolean
  survivor_id: string
  moved: number
  absorbed: string[]
  conflicts: MergeConflict[]
}

/** Preview a merge: how many SKUs move and any blocking site conflicts. */
export async function previewMerge(
  survivorId: string,
  loserIds: string[],
): Promise<ActionResult<{ preview: MergePreview }>> {
  if (!survivorId) return { ok: false, error: "Missing the surviving product." }
  if (!loserIds.length)
    return { ok: false, error: "Pick at least one product to merge in." }

  const supabase = await createClient()
  const { data, error } = await supabase.rpc("merge_products", {
    p_survivor: survivorId,
    p_losers: loserIds,
    p_dry_run: true,
  })
  if (error) return { ok: false, error: dbError(error) }

  const res = data as MergeRpcResult
  return {
    ok: true,
    preview: {
      ok: res.ok,
      moved: res.moved,
      conflicts: res.conflicts ?? [],
    },
  }
}

/** Commit a merge: absorb the chosen products into the survivor. */
export async function mergeProducts(
  survivorId: string,
  loserIds: string[],
): Promise<ActionResult<{ moved: number; absorbed: string[] }>> {
  if (!survivorId) return { ok: false, error: "Missing the surviving product." }
  if (!loserIds.length)
    return { ok: false, error: "Pick at least one product to merge in." }

  const supabase = await createClient()
  const { data, error } = await supabase.rpc("merge_products", {
    p_survivor: survivorId,
    p_losers: loserIds,
    p_dry_run: false,
  })
  if (error) return { ok: false, error: dbError(error) }

  const res = data as MergeRpcResult
  revalidateCatalog(survivorId)
  for (const id of res.absorbed ?? []) revalidatePath(`/catalog/${id}`)
  return { ok: true, moved: res.moved, absorbed: res.absorbed ?? [] }
}

// ---------------------------------------------------------------------------
// Categories (admin-only; enforced by RLS, guarded here for clear messages)
// ---------------------------------------------------------------------------
export async function createCategory(
  name: string,
  parentId: string | null,
): Promise<ActionResult> {
  if (!name?.trim()) return { ok: false, error: "Category name is required." }

  const supabase = await createClient()
  const { error } = await supabase
    .from("categories")
    .insert({ name: name.trim(), parent_id: parentId || null })

  if (error) return { ok: false, error: dbError(error) }
  revalidateCatalog()
  return { ok: true }
}

export async function renameCategory(
  id: string,
  name: string,
): Promise<ActionResult> {
  if (!name?.trim()) return { ok: false, error: "Category name is required." }

  const supabase = await createClient()
  const { error } = await supabase
    .from("categories")
    .update({ name: name.trim() })
    .eq("id", id)

  if (error) return { ok: false, error: dbError(error) }
  revalidateCatalog()
  return { ok: true }
}

export async function reparentCategory(
  id: string,
  parentId: string | null,
): Promise<ActionResult> {
  const supabase = await createClient()

  if (parentId) {
    if (parentId === id)
      return { ok: false, error: "A category can't be its own parent." }
    // Cycle guard: the new parent must not be the category or a descendant.
    const { data: rows, error: readErr } = await supabase
      .from("categories")
      .select("id, name, parent_id")
    if (readErr) return { ok: false, error: dbError(readErr) }
    const blocked = descendantIds((rows ?? []) as CategoryRow[], id)
    if (blocked.has(parentId))
      return {
        ok: false,
        error: "Can't move a category under one of its own descendants.",
      }
  }

  const { error } = await supabase
    .from("categories")
    .update({ parent_id: parentId || null })
    .eq("id", id)

  if (error) return { ok: false, error: dbError(error) }
  revalidateCatalog()
  return { ok: true }
}

export async function deleteCategory(id: string): Promise<ActionResult> {
  const supabase = await createClient()
  const { error } = await supabase.from("categories").delete().eq("id", id)
  if (error)
    return {
      ok: false,
      error: dbError(error, {
        categories_parent_id_fkey:
          "Move or delete the sub-categories first.",
      }),
    }
  revalidateCatalog()
  return { ok: true }
}

// ---- Admin-only catalog delete (migration 0035) ---------------------------
// Hard delete for genuine mistakes; the DB blocks anything with history and
// returns a clear message (check_violation) which dbError() surfaces. The admin
// gate is enforced in the DB too — the UI only hides the button for non-admins.

export async function deleteChildSku(
  id: string,
  productId: string,
): Promise<ActionResult<{ sku: string | null }>> {
  if (!id) return { ok: false, error: "No SKU specified." }
  const supabase = await createClient()
  const { data, error } = await supabase.rpc("delete_child_sku", { p_id: id })
  if (error) return { ok: false, error: dbError(error) }
  revalidatePath(`/catalog/${productId}`)
  revalidatePath("/catalog")
  const r = data as { sku: string | null }
  return { ok: true, sku: r?.sku ?? null }
}

export async function deleteProduct(
  id: string,
): Promise<ActionResult<{ name: string | null }>> {
  if (!id) return { ok: false, error: "No product specified." }
  const supabase = await createClient()
  const { data, error } = await supabase.rpc("delete_product", { p_id: id })
  if (error) return { ok: false, error: dbError(error) }
  revalidatePath("/catalog")
  const r = data as { name: string | null }
  return { ok: true, name: r?.name ?? null }
}
