"use server"

import { revalidatePath } from "next/cache"

import { createClient } from "@/lib/supabase/server"
import { todayISODate } from "@/lib/format"

export type ActionResult = { ok: true } | { ok: false; error: string }

type PgError = { message?: string; details?: string; code?: string } | null

/**
 * WHY THESE ACTIONS ONLY EVER APPEND.
 *
 * Pick-fee charges are snapshotted onto billing_charges at fulfilment (amount,
 * unit rate, and fee_schedule_id), and resolve_fee_schedule() picks the row in
 * force on the order's fulfilment date. That combination is what makes a rate
 * change forward-only — but only if a change is a NEW ROW. Updating the rate on
 * an existing schedule would silently re-price every order that resolves to it,
 * including the backfill path for orders that shipped but were never charged.
 *
 * So publishing a rate is an INSERT, always. Migration 0090 backs this with a
 * trigger that freezes any schedule a billing_charge already points at, so the
 * invariant holds even for service-role writes that bypass RLS.
 */

function err(error: PgError): string {
  if (!error) return "Something went wrong."
  if (error.code === "42501")
    return "Only an admin or manager can change the pick fee."
  if (error.code === "23505")
    return "A rate already starts on that date. Pick a different effective date, or edit the existing one."
  if (error.code === "23514") return "Rates cannot be negative."
  return error.message || error.details || "Something went wrong."
}

function revalidate() {
  revalidatePath("/settings/pick-fee")
  revalidatePath("/settings")
  // The billing report reads charges, not rates, but its "what will this bill"
  // context changes the moment a new rate lands.
  revalidatePath("/reports/billing")
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function validate(
  firstUnitRate: number,
  additionalUnitRate: number,
  effectiveFrom: string,
): string | null {
  if (!Number.isFinite(firstUnitRate) || firstUnitRate < 0)
    return "The first-unit rate must be zero or more."
  if (!Number.isFinite(additionalUnitRate) || additionalUnitRate < 0)
    return "The additional-unit rate must be zero or more."
  if (!DATE_RE.test(effectiveFrom)) return "Pick an effective date."
  return null
}

/**
 * Publish a new rate, effective from a date. Dates are compared in the app
 * timezone (Pacific) because that is what the DB session zone and every order's
 * fulfilled_at::date already use — see migration 0049.
 */
export async function publishFeeSchedule(
  firstUnitRate: number,
  additionalUnitRate: number,
  effectiveFrom: string,
  note: string,
): Promise<ActionResult> {
  const v = validate(firstUnitRate, additionalUnitRate, effectiveFrom)
  if (v) return { ok: false, error: v }

  // A back-dated rate would re-price any order fulfilled on or after that date
  // that has not been charged yet (the billing backfill button). Refuse it: the
  // whole point of this screen is that changes are forward-only.
  if (effectiveFrom < todayISODate())
    return {
      ok: false,
      error:
        "A rate cannot start in the past — that would change what already-shipped orders bill. Use today or a future date.",
    }

  const supabase = await createClient()
  const { data: claimsData } = await supabase.auth.getClaims()

  const { error } = await supabase.from("fee_schedules").insert({
    client_id: null, // one global rate; per-brand rates are a later phase
    effective_from: effectiveFrom,
    first_unit_rate: firstUnitRate,
    additional_unit_rate: additionalUnitRate,
    note: note.trim() || null,
    created_by: claimsData?.claims?.sub ?? null,
  })
  if (error) return { ok: false, error: err(error) }

  revalidate()
  return { ok: true }
}

/**
 * Correct a rate that is queued but has not billed anything yet. The 0090
 * trigger rejects this the moment the schedule has a charge against it, so this
 * cannot reach into closed history even if the UI's guard were wrong.
 */
export async function updateFeeSchedule(
  id: string,
  firstUnitRate: number,
  additionalUnitRate: number,
  effectiveFrom: string,
  note: string,
): Promise<ActionResult> {
  const v = validate(firstUnitRate, additionalUnitRate, effectiveFrom)
  if (v) return { ok: false, error: v }

  if (effectiveFrom < todayISODate())
    return {
      ok: false,
      error: "A rate cannot start in the past. Use today or a future date.",
    }

  const supabase = await createClient()
  const { error } = await supabase
    .from("fee_schedules")
    .update({
      effective_from: effectiveFrom,
      first_unit_rate: firstUnitRate,
      additional_unit_rate: additionalUnitRate,
      note: note.trim() || null,
    })
    .eq("id", id)
  if (error) return { ok: false, error: err(error) }

  revalidate()
  return { ok: true }
}

/** Cancel a queued rate. Blocked by the trigger once it has billed anything. */
export async function deleteFeeSchedule(id: string): Promise<ActionResult> {
  const supabase = await createClient()
  const { error } = await supabase.from("fee_schedules").delete().eq("id", id)
  if (error) return { ok: false, error: err(error) }

  revalidate()
  return { ok: true }
}
