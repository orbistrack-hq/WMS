"use server"

import { revalidatePath } from "next/cache"

import { createClient } from "@/lib/supabase/server"

export type ActionResult = { ok: true } | { ok: false; error: string }

type PgError = { message?: string; details?: string; code?: string } | null

function packError(error: PgError): string {
  if (!error) return "Something went wrong."
  if (error.code === "42501")
    return "Only an admin can remove a packaging line."
  if (error.code === "23514")
    return error.message || "That value isn't allowed."
  return error.message || error.details || "Something went wrong."
}

export async function recordPackaging(
  groupId: string,
  packagingTypeId: string,
  quantity: number,
): Promise<ActionResult> {
  if (!packagingTypeId) return { ok: false, error: "Pick a packaging type." }
  if (!(quantity > 0)) return { ok: false, error: "Quantity must be positive." }

  const supabase = await createClient()
  const { error } = await supabase.rpc("record_packaging_usage", {
    p_group_id: groupId,
    p_packaging_type_id: packagingTypeId,
    p_quantity: Math.trunc(quantity),
  })
  if (error) return { ok: false, error: packError(error) }

  revalidatePath(`/packing/${groupId}`)
  revalidatePath("/packing")
  return { ok: true }
}

export async function updatePackagingQty(
  usageId: string,
  groupId: string,
  quantity: number,
): Promise<ActionResult> {
  if (!(quantity > 0)) return { ok: false, error: "Quantity must be positive." }

  const supabase = await createClient()
  const { error } = await supabase
    .from("packaging_usage")
    .update({ quantity: Math.trunc(quantity) })
    .eq("id", usageId)
  if (error) return { ok: false, error: packError(error) }

  revalidatePath(`/packing/${groupId}`)
  return { ok: true }
}

export async function removePackaging(
  usageId: string,
  groupId: string,
): Promise<ActionResult> {
  const supabase = await createClient()
  const { error } = await supabase
    .from("packaging_usage")
    .delete()
    .eq("id", usageId)
  if (error) return { ok: false, error: packError(error) }

  revalidatePath(`/packing/${groupId}`)
  return { ok: true }
}

export async function packGroup(
  groupId: string,
  notes?: string | null,
): Promise<ActionResult> {
  const supabase = await createClient()
  const { error } = await supabase.rpc("pack_group", {
    p_group_id: groupId,
    p_notes: notes?.trim() || null,
  })
  if (error) return { ok: false, error: packError(error) }

  revalidatePath(`/packing/${groupId}`)
  revalidatePath("/packing")
  revalidatePath("/orders")
  return { ok: true }
}
