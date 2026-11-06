"use server"

import { revalidatePath } from "next/cache"

import { createClient } from "@/lib/supabase/server"
import { isQuality } from "@/lib/shake"

type Result = { ok: true; updated?: number } | { ok: false; error: string }

type PgError = { message?: string; code?: string } | null

function rpcError(error: PgError): string {
  if (!error) return "Something went wrong."
  if (error.code === "42501") return "You don't have permission to do that."
  return error.message || "Something went wrong."
}

/** Set (or clear, with null) the quality of one or more products. */
export async function setProductQuality(
  productIds: string[],
  quality: string | null,
): Promise<Result> {
  if (productIds.length === 0) return { ok: false, error: "Select at least one product." }
  if (quality !== null && !isQuality(quality)) return { ok: false, error: "Unknown quality." }
  const supabase = await createClient()
  const { data, error } = await supabase.rpc("set_product_quality", {
    p_product_ids: productIds,
    p_quality: quality,
  })
  if (error) return { ok: false, error: rpcError(error) }
  revalidatePath("/catalog/quality")
  revalidatePath("/inventory/shake")
  return { ok: true, updated: Number(data ?? 0) }
}

/** Mark a product as a brand shake product (filled from its quality's pot). */
export async function setProductIsShake(productId: string, isShake: boolean): Promise<Result> {
  const supabase = await createClient()
  const { error } = await supabase.rpc("set_product_is_shake", {
    p_product_id: productId,
    p_is_shake: isShake,
  })
  if (error) return { ok: false, error: rpcError(error) }
  revalidatePath("/catalog/quality")
  revalidatePath("/inventory/shake")
  return { ok: true }
}
