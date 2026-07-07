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
// Per-site packaging stock. All writes go through the SECURITY DEFINER guards
// (receive_packaging / adjust_packaging / set_packaging_reorder_point); direct
// table writes are revoked from the API role.
// ---------------------------------------------------------------------------

function stockErr(error: PgError): string {
  if (!error) return "Something went wrong."
  if (error.code === "42501")
    return "You don't have permission to change packaging stock."
  // check_violation from the guards = a business rule (e.g. negative adjust).
  if (
    error.code === "23514" ||
    /negative|positive|required|non-zero/.test(error.message ?? "")
  )
    return error.message || "That change isn't allowed."
  return error.message || error.details || "Something went wrong."
}

/** Receive packaging stock at a site (positive qty, logged as a receipt). */
export async function receivePackaging(
  packagingTypeId: string,
  siteId: string,
  qty: number,
  note?: string | null,
): Promise<ActionResult> {
  if (!packagingTypeId || !siteId)
    return { ok: false, error: "Pick a packaging type and site." }
  if (!(qty > 0)) return { ok: false, error: "Quantity must be positive." }

  const supabase = await createClient()
  const { error } = await supabase.rpc("receive_packaging", {
    p_type: packagingTypeId,
    p_site: siteId,
    p_qty: Math.trunc(qty),
    p_note: note?.trim() || null,
  })
  if (error) return { ok: false, error: stockErr(error) }

  revalidate()
  return { ok: true }
}

/** Manual signed correction with a required note (cannot go negative). */
export async function adjustPackaging(
  packagingTypeId: string,
  siteId: string,
  delta: number,
  note: string,
): Promise<ActionResult> {
  const d = Math.trunc(delta)
  if (!packagingTypeId || !siteId)
    return { ok: false, error: "Pick a packaging type and site." }
  if (!d) return { ok: false, error: "Adjustment can't be zero." }
  if (!note?.trim())
    return { ok: false, error: "A note is required for manual adjustments." }

  const supabase = await createClient()
  const { error } = await supabase.rpc("adjust_packaging", {
    p_type: packagingTypeId,
    p_site: siteId,
    p_delta: d,
    p_note: note.trim(),
  })
  if (error) return { ok: false, error: stockErr(error) }

  revalidate()
  return { ok: true }
}

/** Set (or clear, with null) the per-site low-stock reorder point. */
export async function setPackagingReorderPoint(
  packagingTypeId: string,
  siteId: string,
  point: number | null,
): Promise<ActionResult> {
  if (!packagingTypeId || !siteId)
    return { ok: false, error: "Pick a packaging type and site." }
  const p = point === null || !Number.isFinite(point) ? null : Math.trunc(point)
  if (p !== null && p < 0)
    return { ok: false, error: "Reorder point can't be negative." }

  const supabase = await createClient()
  const { error } = await supabase.rpc("set_packaging_reorder_point", {
    p_type: packagingTypeId,
    p_site: siteId,
    p_point: p,
  })
  if (error) return { ok: false, error: stockErr(error) }

  revalidate()
  return { ok: true }
}
