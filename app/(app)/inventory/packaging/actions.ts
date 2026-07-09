"use server"

import { revalidatePath } from "next/cache"

import { createClient } from "@/lib/supabase/server"

export type ActionResult = { ok: true } | { ok: false; error: string }

// ---------------------------------------------------------------------------
// Central packaging stock actions — thin wrappers over the guarded RPCs
// (receive_packaging / adjust_packaging / set_packaging_reorder_point, central
// forms from migration 0047). The RPCs own validation + the ops-role gate;
// these just translate errors for operators. No site: packaging is one central
// pool shared across every site.
// ---------------------------------------------------------------------------

type PgError = { message?: string; details?: string; code?: string } | null

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

function revalidate() {
  revalidatePath("/inventory/packaging")
  // The packing screen lists active types + their costs in its packaging editor.
  revalidatePath("/packing")
}

/** Receive packaging stock into the central pool (positive qty, logged). */
export async function receivePackaging(
  packagingTypeId: string,
  qty: number,
  note?: string | null,
): Promise<ActionResult> {
  if (!packagingTypeId) return { ok: false, error: "Pick a packaging type." }
  if (!(qty > 0)) return { ok: false, error: "Quantity must be positive." }

  const supabase = await createClient()
  const { error } = await supabase.rpc("receive_packaging", {
    p_type: packagingTypeId,
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
  delta: number,
  note: string,
): Promise<ActionResult> {
  const d = Math.trunc(delta)
  if (!packagingTypeId) return { ok: false, error: "Pick a packaging type." }
  if (!d) return { ok: false, error: "Adjustment can't be zero." }
  if (!note?.trim())
    return { ok: false, error: "A note is required for manual adjustments." }

  const supabase = await createClient()
  const { error } = await supabase.rpc("adjust_packaging", {
    p_type: packagingTypeId,
    p_delta: d,
    p_note: note.trim(),
  })
  if (error) return { ok: false, error: stockErr(error) }

  revalidate()
  return { ok: true }
}

/** Set (or clear, with null) the central low-stock reorder point. */
export async function setPackagingReorderPoint(
  packagingTypeId: string,
  point: number | null,
): Promise<ActionResult> {
  if (!packagingTypeId) return { ok: false, error: "Pick a packaging type." }
  const p = point === null || !Number.isFinite(point) ? null : Math.trunc(point)
  if (p !== null && p < 0)
    return { ok: false, error: "Reorder point can't be negative." }

  const supabase = await createClient()
  const { error } = await supabase.rpc("set_packaging_reorder_point", {
    p_type: packagingTypeId,
    p_point: p,
  })
  if (error) return { ok: false, error: stockErr(error) }

  revalidate()
  return { ok: true }
}
