"use server"

import { revalidatePath } from "next/cache"

import { createClient } from "@/lib/supabase/server"
import { kickOutboundDrain } from "@/lib/store-sync/outbound"

export type ActionResult = { ok: true } | { ok: false; error: string }

/** Transfer result: success, a plain error, or a soft-warning gate the user
 *  must acknowledge (cost/SKU mismatch) before the move is allowed. */
export type TransferResult =
  | { ok: true }
  | { ok: false; error: string }
  | { ok: false; needsAck: true; warnings: string[] }

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

/**
 * Transfer AVAILABLE units of a finished child SKU to the same product's child
 * SKU at another site. The RPC guards conservation, reserved-safety, and the
 * same-product rule. If source/dest cost or SKU differ it refuses (SQLSTATE
 * WMS01) with the reasons, unless `ackWarnings` is true — the UI shows a
 * confirm dialog, then resubmits with ackWarnings set. Both sites' stores are
 * re-synced automatically by the inventory_levels trigger.
 */
export async function transferStock(
  sourceChildId: string,
  destChildId: string,
  units: number,
  note: string | null,
  ackWarnings = false,
): Promise<TransferResult> {
  const n = Math.trunc(units)
  if (!(n > 0)) return { ok: false, error: "Enter a positive quantity." }
  if (sourceChildId === destChildId)
    return { ok: false, error: "Pick a different destination site." }

  const supabase = await createClient()
  const { error } = await supabase.rpc("transfer_stock", {
    p_source_child: sourceChildId,
    p_dest_child: destChildId,
    p_units: n,
    p_note: note?.trim() || null,
    p_ack_warnings: ackWarnings,
  })

  if (error) {
    // WMS01 = soft warning gate; message is "WARN: reason | reason".
    if (error.code === "WMS01") {
      const warnings = (error.message ?? "")
        .replace(/^.*?WARN:\s*/, "")
        .split(" | ")
        .map((s) => s.trim())
        .filter(Boolean)
      return { ok: false, needsAck: true, warnings }
    }
    return { ok: false, error: invError(error) }
  }

  revalidatePath(`/inventory/${sourceChildId}`)
  revalidatePath(`/inventory/${destChildId}`)
  revalidatePath("/inventory")
  // Push the new available count out to both sites' stores (no-op otherwise).
  await kickOutboundDrain()
  return { ok: true }
}
