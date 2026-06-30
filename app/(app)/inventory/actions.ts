"use server"

import { revalidatePath } from "next/cache"

import { createClient } from "@/lib/supabase/server"
import { kickOutboundDrain } from "@/lib/store-sync/outbound"

export type ActionResult = { ok: true } | { ok: false; error: string }

type PgError = { message?: string; details?: string; code?: string } | null

function invError(error: PgError): string {
  if (!error) return "Something went wrong."
  // check_violation from the guarded inventory functions = a business rule hit.
  if (error.code === "23514" || /reserved|negative/.test(error.message ?? ""))
    return (
      error.message ||
      "That change isn't allowed — it would drop stock below what's reserved."
    )
  if (error.code === "42501") return "You don't have permission to do that."
  return error.message || error.details || "Something went wrong."
}

/** Receive stock: a positive quantity, logged to the ledger as a receipt. */
export async function receiveStock(
  childSkuId: string,
  qty: number,
  note?: string | null,
): Promise<ActionResult> {
  if (!(qty > 0)) return { ok: false, error: "Quantity must be positive." }

  const supabase = await createClient()
  const { error } = await supabase.rpc("receive_stock", {
    p_child_sku_id: childSkuId,
    p_qty: Math.trunc(qty),
    p_note: note?.trim() || null,
  })
  if (error) return { ok: false, error: invError(error) }

  revalidatePath(`/inventory/${childSkuId}`)
  revalidatePath("/inventory")
  // Push the new available out to any outbound-enabled store (no-op otherwise).
  await kickOutboundDrain()
  return { ok: true }
}

/**
 * Manual adjustment: a non-zero delta with a required note. Writes the
 * before/after to the ledger (reason = manual_adjustment).
 */
export async function adjustStock(
  childSkuId: string,
  delta: number,
  note: string,
): Promise<ActionResult> {
  const d = Math.trunc(delta)
  if (!d) return { ok: false, error: "Adjustment can't be zero." }
  if (!note?.trim())
    return { ok: false, error: "A note is required for manual adjustments." }

  const supabase = await createClient()
  const { error } = await supabase.rpc("adjust_stock", {
    p_child_sku_id: childSkuId,
    p_delta: d,
    p_note: note.trim(),
  })
  if (error) return { ok: false, error: invError(error) }

  revalidatePath(`/inventory/${childSkuId}`)
  revalidatePath("/inventory")
  await kickOutboundDrain()
  return { ok: true }
}
