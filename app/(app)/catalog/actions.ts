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
      description: input.description?.trim() || null,
      category_id: input.category_id || null,
      is_active: input.is_active ?? true,
    })
    .eq("id", id)

  if (error) return { ok: false, error: dbError(error) }
  revalidateCatalog(id)
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Child SKUs (one product at one site)
// ---------------------------------------------------------------------------
export type ChildSkuInput = {
  product_id: string
  site_id: string
  sku?: string | null
  store_variant_id?: string | null
  price: number
  cost: number
  is_active?: boolean
}

const SKU_CONFLICTS = {
  child_skus_pkey: "This product already has a SKU at this site.",
  child_skus_product_id_site_id_key:
    "This product already has a SKU at this site.",
  child_skus_site_sku_key: "That SKU code is already used at this site.",
}

export async function createChildSku(
  input: ChildSkuInput,
): Promise<ActionResult> {
  if (!input.site_id) return { ok: false, error: "Pick a site." }
  if (!(input.price >= 0) || !(input.cost >= 0))
    return { ok: false, error: "Price and cost must be zero or more." }

  const supabase = await createClient()
  const { error } = await supabase.from("child_skus").insert({
    product_id: input.product_id,
    site_id: input.site_id,
    sku: input.sku?.trim() || null,
    store_variant_id: input.store_variant_id?.trim() || null,
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

  const supabase = await createClient()
  const { error } = await supabase
    .from("child_skus")
    .update({
      sku: input.sku?.trim() || null,
      store_variant_id: input.store_variant_id?.trim() || null,
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
