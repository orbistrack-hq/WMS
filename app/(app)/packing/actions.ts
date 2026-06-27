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

// ---------------------------------------------------------------------------
// Interactive picking
// ---------------------------------------------------------------------------

export type ClaimState = {
  holderId: string | null
  holderName: string | null
  /** The caller holds the claim after this call. */
  isSelf: boolean
  /** The caller took the claim from another picker. */
  takenOver: boolean
}

/** Claim, or take over, a group for picking (soft lock). */
export async function claimPick(
  groupId: string,
  takeover = false,
): Promise<{ ok: true; claim: ClaimState } | { ok: false; error: string }> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc("claim_pick", {
    p_group_id: groupId,
    p_takeover: takeover,
  })
  if (error) return { ok: false, error: packError(error) }

  const r = data as {
    holder_id: string | null
    holder_name: string | null
    is_self: boolean
    taken_over: boolean
  }
  return {
    ok: true,
    claim: {
      holderId: r.holder_id,
      holderName: r.holder_name,
      isSelf: r.is_self,
      takenOver: r.taken_over,
    },
  }
}

export type PickResult = {
  childSkuId: string
  qtyPicked: number
  required: number
  short: boolean
  /** Every required SKU in the group is now picked or marked short. */
  complete: boolean
}

/** Record picked quantity for a line (clamped server-side); flag short stock. */
export async function setPickQty(
  groupId: string,
  childSkuId: string,
  qty: number,
  short = false,
): Promise<{ ok: true; result: PickResult } | { ok: false; error: string }> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc("set_pick_qty", {
    p_group_id: groupId,
    p_child_sku_id: childSkuId,
    p_qty: Math.trunc(qty),
    p_short: short,
  })
  if (error) return { ok: false, error: packError(error) }

  const r = data as {
    child_sku_id: string
    qty_picked: number
    required: number
    short: boolean
    complete: boolean
  }
  revalidatePath(`/packing/${groupId}/pick`)
  revalidatePath(`/packing/${groupId}`)
  revalidatePath("/packing")
  return {
    ok: true,
    result: {
      childSkuId: r.child_sku_id,
      qtyPicked: r.qty_picked,
      required: r.required,
      short: r.short,
      complete: r.complete,
    },
  }
}
