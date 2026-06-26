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
    return "Only an admin can manage packaging types."
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
): Promise<ActionResult> {
  const v = validate(name, kind, unitCost)
  if (v) return { ok: false, error: v }

  const supabase = await createClient()
  const { error } = await supabase.from("packaging_types").insert({
    name: name.trim(),
    kind,
    unit_cost: unitCost,
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
