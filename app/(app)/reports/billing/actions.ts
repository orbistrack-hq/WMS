"use server"

import { revalidatePath } from "next/cache"

import { createClient } from "@/lib/supabase/server"

export type BackfillResult =
  | { ok: true; charged: number; skipped: number; failed: number; firstError?: string }
  | { ok: false; error: string }

/**
 * Record the missing pick fee on orders that were fulfilled without one.
 *
 * WHY THIS IS SAFE TO RUN ON OLD ORDERS. charge_order_pick_fee dates the charge
 * off the order's own fulfilled_at, not off today:
 *
 *     select coalesce(fulfilled_at::date, current_date) into v_date
 *     v_sched := public.resolve_fee_schedule(v_date)
 *
 * so an order fulfilled in March is billed at March's rate even if the schedule
 * changed since. Backfilling months later produces exactly the charge that
 * should have been written at the time.
 *
 * WHY IT CANNOT DOUBLE-CHARGE. The function returns any existing pick_fee row
 * untouched unless p_recompute is true, and a unique index
 * (billing_charges_one_pick_fee on order_id where fee_type = 'pick_fee') backs
 * that up at the storage layer. p_recompute is deliberately NOT exposed here:
 * this action only ever fills gaps, it never rewrites a charge that already
 * exists. Re-running it is a no-op.
 *
 * PER-ORDER FAILURES ARE COUNTED, NOT FATAL. The function raises on an order
 * with no billable units, and on any order whose fulfilment date predates the
 * earliest fee schedule. One bad order must not abort the run and leave the
 * batch half-applied, so each is charged in its own call and failures are
 * tallied and reported.
 *
 * ADMIN/MANAGER ONLY. charge_order_pick_fee is SECURITY DEFINER with no role
 * check of its own — it is normally called by the fulfilment RPCs, not by a
 * person. Writing billable charges by hand is a money operation, so it is gated
 * here to match force_fulfill_order.
 */
export async function backfillPickFees(orderIds: string[]): Promise<BackfillResult> {
  const ids = Array.from(new Set(orderIds.filter(Boolean)))
  if (ids.length === 0) return { ok: false, error: "No orders to charge." }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Not signed in." }
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle()
  if (profile?.role !== "admin" && profile?.role !== "manager") {
    return { ok: false, error: "Only an admin or manager can record pick fees." }
  }

  // Which of these already have a charge — so "skipped" reports something real
  // rather than counting every idempotent no-op as a fresh charge.
  const already = new Set<string>()
  for (let i = 0; i < ids.length; i += 300) {
    const { data } = await supabase
      .from("billing_charges")
      .select("order_id")
      .eq("fee_type", "pick_fee")
      .in("order_id", ids.slice(i, i + 300))
    for (const r of (data ?? []) as { order_id: string }[]) already.add(r.order_id)
  }

  let charged = 0
  let failed = 0
  let firstError: string | undefined

  for (const id of ids) {
    if (already.has(id)) continue
    const { error } = await supabase.rpc("charge_order_pick_fee", {
      p_order_id: id,
      p_recompute: false,
    })
    if (error) {
      failed++
      if (!firstError) firstError = error.message
    } else {
      charged++
    }
  }

  revalidatePath("/reports/billing")
  revalidatePath("/reports/backorders")
  return { ok: true, charged, skipped: already.size, failed, firstError }
}
