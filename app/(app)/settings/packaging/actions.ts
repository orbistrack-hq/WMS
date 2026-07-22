"use server"

import { revalidatePath } from "next/cache"

import { createClient } from "@/lib/supabase/server"

export type ActionResult = { ok: true } | { ok: false; error: string }

// Mirrors the kind CHECK constraint on packaging_types. Kept private: a
// "use server" module may only export async functions, so the UI keeps its own
// copy of this list.
const KINDS = [
  "box",
  "shipping_label",
  "jar",
  "jar_label",
  "vacuum_bag",
  "mylar_bag",
  "custom",
]

type PgError = { message?: string; details?: string; code?: string } | null

function err(error: PgError): string {
  if (!error) return "Something went wrong."
  if (error.code === "42501")
    return "You can only manage packaging types for a site you have access to. Shared defaults are admin-only."
  if (error.code === "23503")
    return "This type is used in packing history — deactivate it instead of deleting."
  if (error.code === "23514") return "Pick a valid packaging kind."
  return error.message || error.details || "Something went wrong."
}

function revalidate() {
  revalidatePath("/settings/packaging")
  // The packing screen lists active types in its packaging editor.
  revalidatePath("/packing")
}

function validate(
  name: string,
  kind: string,
  unitCost: number,
): string | null {
  if (!name.trim()) return "Name is required."
  if (!KINDS.includes(kind)) return "Pick a valid packaging kind."
  if (!Number.isFinite(unitCost) || unitCost < 0)
    return "Unit cost must be zero or more."
  return null
}

export async function createPackagingType(
  name: string,
  kind: string,
  unitCost: number,
  // Which site owns this type. null = a shared default (admin-only). A non-null
  // site scopes the type to that site; RLS enforces the caller can access it.
  siteId: string | null,
): Promise<ActionResult> {
  const v = validate(name, kind, unitCost)
  if (v) return { ok: false, error: v }

  const supabase = await createClient()
  const { error } = await supabase.from("packaging_types").insert({
    name: name.trim(),
    kind,
    unit_cost: unitCost,
    site_id: siteId || null,
    is_active: true,
  })
  if (error) return { ok: false, error: err(error) }

  revalidate()
  return { ok: true }
}

export async function updatePackagingType(
  id: string,
  name: string,
  kind: string,
  unitCost: number,
): Promise<ActionResult> {
  const v = validate(name, kind, unitCost)
  if (v) return { ok: false, error: v }

  const supabase = await createClient()
  const { error } = await supabase
    .from("packaging_types")
    .update({ name: name.trim(), kind, unit_cost: unitCost })
    .eq("id", id)
  if (error) return { ok: false, error: err(error) }

  revalidate()
  return { ok: true }
}

export async function setPackagingTypeActive(
  id: string,
  isActive: boolean,
): Promise<ActionResult> {
  const supabase = await createClient()
  const { error } = await supabase
    .from("packaging_types")
    .update({ is_active: isActive })
    .eq("id", id)
  if (error) return { ok: false, error: err(error) }

  revalidate()
  return { ok: true }
}

export async function deletePackagingType(id: string): Promise<ActionResult> {
  const supabase = await createClient()
  const { error } = await supabase.from("packaging_types").delete().eq("id", id)
  if (error) return { ok: false, error: err(error) }

  revalidate()
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Low-stock alert quantity (central reorder point, migration 0047). Setting it
// drives the red portal-wide banner + the "low" badges. Passing null clears the
// alert. The set_packaging_reorder_point RPC owns the manager-level gate
// (admin/operator/manager via is_operator); this wrapper just revalidates the
// pages that surface the threshold or the resulting alert.
// ---------------------------------------------------------------------------

export async function setPackagingReorderPoint(
  packagingTypeId: string,
  point: number | null,
): Promise<ActionResult> {
  if (!packagingTypeId) return { ok: false, error: "Pick a packaging type." }
  const p = point === null || !Number.isFinite(point) ? null : Math.trunc(point)
  if (p !== null && p < 0)
    return { ok: false, error: "Alert quantity can't be negative." }

  const supabase = await createClient()
  const { error } = await supabase.rpc("set_packaging_reorder_point", {
    p_type: packagingTypeId,
    p_point: p,
  })
  if (error) {
    if (error.code === "42501")
      return {
        ok: false,
        error: "Only a manager or admin can set the alert quantity.",
      }
    return { ok: false, error: error.message || "Something went wrong." }
  }

  revalidatePath("/settings/packaging")
  revalidatePath("/inventory/packaging")
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Weight→packaging rule (FB-3, migration 0040). One global threshold: units at
// or below it are jarred, heavier ones bagged. Admin-only (enforced by RLS on
// packaging_rule); a non-admin update simply affects no rows.
// ---------------------------------------------------------------------------

export async function updatePackagingRule(
  jarMaxGrams: number,
): Promise<ActionResult> {
  if (!Number.isFinite(jarMaxGrams) || jarMaxGrams <= 0)
    return { ok: false, error: "Threshold must be greater than zero." }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  // Single config row; update all (there is exactly one). RLS gates to admins.
  const { data, error } = await supabase
    .from("packaging_rule")
    .update({ jar_max_grams: jarMaxGrams, updated_by: user?.id ?? null })
    .eq("singleton", true)
    .select("id")
  if (error) return { ok: false, error: err(error) }
  if (!data || data.length === 0)
    return {
      ok: false,
      error: "Only an admin can change the packaging rule.",
    }

  revalidate()
  revalidatePath("/packing")
  return { ok: true }
}

// Packaging STOCK actions moved to app/(app)/inventory/packaging/actions.ts in
// migration 0047 (central pool, no site). This settings module now only manages
// packaging TYPES, the jar/bag rule, and the weight → packaging map.

// ---------------------------------------------------------------------------
// Weight → packaging map + per-order defaults (FB-6, migration 0046). Managed
// by the ops team (operator/admin) via RLS; the packing screens read them to
// auto-fill packaging. Changing them re-drives the auto-calc, so revalidate
// /packing too.
// ---------------------------------------------------------------------------

function ruleErr(error: PgError): string {
  if (!error) return "Something went wrong."
  if (error.code === "42501")
    return "Only the ops team (operator/admin) can change packaging rules."
  if (error.code === "23505")
    return "That weight already maps to this packaging type."
  if (error.code === "23503") return "Pick a valid packaging type."
  return error.message || error.details || "Something went wrong."
}

function revalidateRules() {
  revalidatePath("/settings/packaging")
  revalidatePath("/packing")
}

export async function addWeightRule(
  gramsPerUnit: number,
  packagingTypeId: string,
  qtyPerUnit: number,
): Promise<ActionResult> {
  if (!(gramsPerUnit > 0))
    return { ok: false, error: "Weight must be greater than zero." }
  if (!packagingTypeId) return { ok: false, error: "Pick a packaging type." }
  if (!(qtyPerUnit > 0))
    return { ok: false, error: "Quantity must be at least 1." }

  const supabase = await createClient()
  const { error } = await supabase.from("packaging_weight_rule").insert({
    grams_per_unit: gramsPerUnit,
    packaging_type_id: packagingTypeId,
    qty_per_unit: Math.trunc(qtyPerUnit),
  })
  if (error) return { ok: false, error: ruleErr(error) }

  revalidateRules()
  return { ok: true }
}

export async function updateWeightRuleQty(
  id: string,
  qtyPerUnit: number,
): Promise<ActionResult> {
  if (!(qtyPerUnit > 0))
    return { ok: false, error: "Quantity must be at least 1." }

  const supabase = await createClient()
  const { error } = await supabase
    .from("packaging_weight_rule")
    .update({ qty_per_unit: Math.trunc(qtyPerUnit) })
    .eq("id", id)
  if (error) return { ok: false, error: ruleErr(error) }

  revalidateRules()
  return { ok: true }
}

export async function deleteWeightRule(id: string): Promise<ActionResult> {
  const supabase = await createClient()
  const { error } = await supabase
    .from("packaging_weight_rule")
    .delete()
    .eq("id", id)
  if (error) return { ok: false, error: ruleErr(error) }

  revalidateRules()
  return { ok: true }
}

export async function addOrderDefault(
  packagingTypeId: string,
  qty: number,
): Promise<ActionResult> {
  if (!packagingTypeId) return { ok: false, error: "Pick a packaging type." }
  if (!(qty > 0)) return { ok: false, error: "Quantity must be at least 1." }

  const supabase = await createClient()
  const { error } = await supabase.from("packaging_order_default").insert({
    packaging_type_id: packagingTypeId,
    qty: Math.trunc(qty),
  })
  if (error) return { ok: false, error: ruleErr(error) }

  revalidateRules()
  return { ok: true }
}

export async function updateOrderDefaultQty(
  id: string,
  qty: number,
): Promise<ActionResult> {
  if (!(qty > 0)) return { ok: false, error: "Quantity must be at least 1." }

  const supabase = await createClient()
  const { error } = await supabase
    .from("packaging_order_default")
    .update({ qty: Math.trunc(qty) })
    .eq("id", id)
  if (error) return { ok: false, error: ruleErr(error) }

  revalidateRules()
  return { ok: true }
}

export async function deleteOrderDefault(id: string): Promise<ActionResult> {
  const supabase = await createClient()
  const { error } = await supabase
    .from("packaging_order_default")
    .delete()
    .eq("id", id)
  if (error) return { ok: false, error: ruleErr(error) }

  revalidateRules()
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Per-child-SKU packaging override (FB-6 extension, migration 0080). A child
// SKU listed here uses the mapped packaging type INSTEAD of its weight-derived
// packaging (e.g. free eighths → 7g Mylar bag even though they weigh 3.5g).
// Ops-managed (is_operator via RLS); read by the packing screens. Changing one
// re-drives the auto-calc, so revalidate /packing too.
// ---------------------------------------------------------------------------

function skuRuleErr(error: PgError): string {
  if (!error) return "Something went wrong."
  if (error.code === "42501")
    return "Only the ops team (operator/admin) can change packaging rules."
  if (error.code === "23505")
    return "That SKU already maps to this packaging type."
  if (error.code === "23503") return "Pick a valid SKU and packaging type."
  return error.message || error.details || "Something went wrong."
}

/**
 * Map every child SKU with this SKU code to a packaging type. Resolving by code
 * (not a single id) mirrors the seed: a promotional product is the same across
 * sites, so "this SKU ships in a Mylar bag" should cover all its per-site
 * children at once. Existing (child, type) pairs are left untouched.
 */
export async function addSkuRuleByCode(
  skuCode: string,
  packagingTypeId: string,
  qtyPerUnit: number,
): Promise<ActionResult> {
  const code = skuCode.trim()
  if (!code) return { ok: false, error: "Enter a SKU code." }
  if (!packagingTypeId) return { ok: false, error: "Pick a packaging type." }
  if (!(qtyPerUnit > 0))
    return { ok: false, error: "Quantity must be at least 1." }

  const supabase = await createClient()
  // Case-insensitive exact match on the SKU code. RLS already scopes child_skus
  // to sites the caller can see, so a client only maps its own SKUs.
  const { data: matches, error: findErr } = await supabase
    .from("child_skus")
    .select("id")
    .ilike("sku", code)
  if (findErr) return { ok: false, error: skuRuleErr(findErr) }
  if (!matches || matches.length === 0)
    return {
      ok: false,
      error: `No SKU matches "${code}". Check the code and try again.`,
    }

  const rows = matches.map((m) => ({
    child_sku_id: m.id as string,
    packaging_type_id: packagingTypeId,
    qty_per_unit: Math.trunc(qtyPerUnit),
  }))
  // Ignore rows that already exist for this (child, type) so re-adding is safe.
  const { error } = await supabase
    .from("packaging_sku_rule")
    .upsert(rows, {
      onConflict: "child_sku_id,packaging_type_id",
      ignoreDuplicates: true,
    })
  if (error) return { ok: false, error: skuRuleErr(error) }

  revalidateRules()
  return { ok: true }
}

export async function updateSkuRuleQty(
  id: string,
  qtyPerUnit: number,
): Promise<ActionResult> {
  if (!(qtyPerUnit > 0))
    return { ok: false, error: "Quantity must be at least 1." }

  const supabase = await createClient()
  const { error } = await supabase
    .from("packaging_sku_rule")
    .update({ qty_per_unit: Math.trunc(qtyPerUnit) })
    .eq("id", id)
  if (error) return { ok: false, error: skuRuleErr(error) }

  revalidateRules()
  return { ok: true }
}

export async function deleteSkuRule(id: string): Promise<ActionResult> {
  const supabase = await createClient()
  const { error } = await supabase
    .from("packaging_sku_rule")
    .delete()
    .eq("id", id)
  if (error) return { ok: false, error: skuRuleErr(error) }

  revalidateRules()
  return { ok: true }
}
