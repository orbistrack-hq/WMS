"use server"

import { revalidatePath } from "next/cache"

import { createClient } from "@/lib/supabase/server"
import { computeOrderPackaging, topUpLines } from "@/lib/packing/packaging-rules"
import { loadPackagingConfig } from "@/lib/packing/load-packaging-config"

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

// ---------------------------------------------------------------------------
// Re-apply weight-based packaging (top up only)
// ---------------------------------------------------------------------------
// A line packed while its child SKU had no weight got no jar/bag — the group is
// short on consumables. After the weight is corrected in the catalog, this
// recomputes the target from the current weights and records ONLY the deficit
// per packaging kind (see topUpLines): box/label and any hand-added lines are
// left untouched, nothing is removed, and it never exceeds the target — so it's
// safe to press more than once. record_packaging_usage has no status guard, so
// this also works on an already-fulfilled group.

export type TopUpResult =
  | {
      ok: true
      added: { typeName: string; qty: number }[]
      /** Units still with no weight after top-up — fix these in the catalog. */
      unknownWeightUnits: number
    }
  | { ok: false; error: string }

type TopUpUsageRow = {
  id: string
  quantity: number
  packaging_type_id: string
  packaging_type: { kind: string | null } | null
}

type TopUpGroup = {
  orders: {
    order_line_items: {
      quantity: number
      child_sku: { grams_per_unit: number | string | null } | null
    }[]
  }[]
  packaging_usage: TopUpUsageRow[]
}

export async function topUpPackagingFromWeight(
  groupId: string,
): Promise<TopUpResult> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("fulfillment_groups")
    .select(
      `id,
       orders(order_line_items(quantity,
         child_sku:child_skus(grams_per_unit))),
       packaging_usage(id, quantity, packaging_type_id,
         packaging_type:packaging_types(kind))`,
    )
    .eq("id", groupId)
    .maybeSingle()
  if (error) return { ok: false, error: packError(error) }
  if (!data) return { ok: false, error: "That group no longer exists." }

  const group = data as unknown as TopUpGroup

  const units = group.orders.flatMap((o) =>
    o.order_line_items.map((li) => ({
      gramsPerUnit:
        li.child_sku?.grams_per_unit == null
          ? null
          : Number(li.child_sku.grams_per_unit),
      qty: li.quantity,
    })),
  )

  const config = await loadPackagingConfig(supabase)
  const computed = computeOrderPackaging(
    units,
    config.weightRules,
    config.orderDefaults,
  )
  const recorded = group.packaging_usage.map((u) => ({
    kind: u.packaging_type?.kind ?? "custom",
    quantity: u.quantity,
  }))
  const toAdd = topUpLines(computed, recorded)

  // Sequential so a failed write surfaces its error and stops rather than
  // half-applying blind. When a line's packaging TYPE already has a usage row,
  // bump that row's quantity instead of inserting a second row of the same type
  // — only insert when the type isn't recorded yet (e.g. a config jar type that
  // was never added). Keeps the editor to one line per type.
  for (const line of toAdd) {
    const existing = group.packaging_usage.find(
      (u) => u.packaging_type_id === line.typeId,
    )
    if (existing) {
      const { error: updErr } = await supabase
        .from("packaging_usage")
        .update({ quantity: existing.quantity + line.qty })
        .eq("id", existing.id)
      if (updErr) return { ok: false, error: packError(updErr) }
    } else {
      const { error: recErr } = await supabase.rpc("record_packaging_usage", {
        p_group_id: groupId,
        p_packaging_type_id: line.typeId,
        p_quantity: line.qty,
      })
      if (recErr) return { ok: false, error: packError(recErr) }
    }
  }

  revalidatePath(`/packing/${groupId}`)
  revalidatePath("/packing")
  return {
    ok: true,
    added: toAdd.map((l) => ({ typeName: l.typeName, qty: l.qty })),
    unknownWeightUnits: computed.unknownWeightUnits,
  }
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
  const { data, error } = await supabase
    .from("packaging_usage")
    .delete()
    .eq("id", usageId)
    .select("id")
  if (error) return { ok: false, error: packError(error) }
  // RLS can silently filter a DELETE to zero rows (no error). Surface that as a
  // real failure instead of a no-op that looks like it worked.
  if (!data || data.length === 0)
    return {
      ok: false,
      error:
        "That packaging line couldn't be removed — you may not have permission to. Ask an admin.",
    }

  revalidatePath(`/packing/${groupId}`)
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Dismiss / hide stale packing groups (migration 0053). Non-destructive: hides a
// group from the packing queue without touching orders, inventory, or billing.
// Operator-level (admin/operator/manager) — the RPC enforces it.
// ---------------------------------------------------------------------------

function dismissError(error: PgError): string {
  if (!error) return "Something went wrong."
  if (error.code === "42501")
    return "You don't have permission to change the packing queue."
  return error.message || error.details || "Something went wrong."
}

export async function dismissGroup(groupId: string): Promise<ActionResult> {
  const supabase = await createClient()
  const { error } = await supabase.rpc("dismiss_fulfillment_group", {
    p_group_id: groupId,
  })
  if (error) return { ok: false, error: dismissError(error) }

  revalidatePath("/packing")
  return { ok: true }
}

export async function undismissGroup(groupId: string): Promise<ActionResult> {
  const supabase = await createClient()
  const { error } = await supabase.rpc("undismiss_fulfillment_group", {
    p_group_id: groupId,
  })
  if (error) return { ok: false, error: dismissError(error) }

  revalidatePath("/packing")
  return { ok: true }
}

/**
 * Un-hide every currently hidden open group — the inverse of "Hide orders
 * before a date". There is no bulk-undismiss RPC, so we reuse the guarded
 * per-group RPC (which enforces the operator check and is idempotent). Calls run
 * in bounded-concurrency chunks so a large batch neither serialises into a slow
 * crawl nor floods the pooler. Non-destructive and safe to re-run: a partial
 * failure just leaves the rest hidden, and running again finishes the job.
 */
export async function undismissAllHidden(): Promise<
  { ok: true; count: number } | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from("fulfillment_groups")
    .select("id")
    .eq("status", "open")
    .not("dismissed_at", "is", null)
  if (error) return { ok: false, error: dismissError(error) }

  const ids = (data ?? []).map((r) => r.id as string)
  const CHUNK = 20
  let count = 0
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK)
    const results = await Promise.all(
      chunk.map((id) =>
        supabase.rpc("undismiss_fulfillment_group", { p_group_id: id }),
      ),
    )
    const failed = results.find((r) => r.error)
    if (failed?.error) return { ok: false, error: dismissError(failed.error) }
    count += chunk.length
  }

  revalidatePath("/packing")
  return { ok: true, count }
}

/** Bulk-hide every open group whose window is before the cutoff (ISO string). */
export async function dismissStaleGroups(
  before: string,
): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  if (!before) return { ok: false, error: "Pick a cutoff date." }

  const supabase = await createClient()
  const { data, error } = await supabase.rpc("dismiss_stale_fulfillment_groups", {
    p_before: before,
  })
  if (error) return { ok: false, error: dismissError(error) }

  revalidatePath("/packing")
  return { ok: true, count: (data as number) ?? 0 }
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

/**
 * Mark every still-to-pick SKU in a group as fully picked, in one call. Used by
 * the wave "Sort to orders" confirm: sorting the gathered stock back out to each
 * order IS the pick, so we record pick_progress before packing. set_pick_qty
 * clamps each line to its required qty (pick_required = orders still in
 * created/picking), so this is idempotent and never over-picks. Without it,
 * pack_group's pick gate rejects a wave-confirmed group with "Finish picking
 * this group before packing it" — even though the wave screen is the pick step.
 */
export async function markGroupPicked(groupId: string): Promise<ActionResult> {
  const supabase = await createClient()
  const { data: required, error: reqErr } = await supabase.rpc("pick_required", {
    p_group_id: groupId,
  })
  if (reqErr) return { ok: false, error: packError(reqErr) }

  for (const row of (required ?? []) as {
    child_sku_id: string
    required: number
  }[]) {
    const { error } = await supabase.rpc("set_pick_qty", {
      p_group_id: groupId,
      p_child_sku_id: row.child_sku_id,
      p_qty: row.required,
      p_short: false,
    })
    if (error) return { ok: false, error: packError(error) }
  }

  revalidatePath(`/packing/${groupId}`)
  revalidatePath("/packing")
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Shipping — operational only. None of these touch the order lifecycle;
// fulfillment stays a separate, explicit step (fulfill_order).
// ---------------------------------------------------------------------------

function shipError(error: PgError): string {
  if (!error) return "Something went wrong."
  if (error.code === "42501")
    return "Only an admin can delete a shipment or package."
  if (error.code === "23514")
    return error.message || "That value isn't allowed."
  return error.message || error.details || "Something went wrong."
}

// Parse an optional money/number input. Empty string -> null (clears the field).
function optNum(v: number | string | null | undefined): number | null {
  if (v === "" || v === null || v === undefined) return null
  const n = typeof v === "string" ? Number(v) : v
  return Number.isFinite(n) ? n : null
}

export async function createShipment(
  groupId: string,
  fields: { carrier?: string; serviceLevel?: string; estimatedCost?: string },
): Promise<ActionResult> {
  const supabase = await createClient()
  const { error } = await supabase.rpc("create_shipment", {
    p_group_id: groupId,
    p_carrier: fields.carrier?.trim() || null,
    p_service_level: fields.serviceLevel?.trim() || null,
    p_estimated_cost: optNum(fields.estimatedCost),
  })
  if (error) return { ok: false, error: shipError(error) }

  revalidatePath(`/packing/${groupId}`)
  return { ok: true }
}

export async function updateShipment(
  shipmentId: string,
  groupId: string,
  fields: {
    carrier?: string
    serviceLevel?: string
    estimatedCost?: string
    actualCost?: string
  },
): Promise<ActionResult> {
  const supabase = await createClient()
  const { error } = await supabase.rpc("update_shipment", {
    p_shipment_id: shipmentId,
    p_carrier: fields.carrier?.trim() || null,
    p_service_level: fields.serviceLevel?.trim() || null,
    p_estimated_cost: optNum(fields.estimatedCost),
    p_actual_cost: optNum(fields.actualCost),
  })
  if (error) return { ok: false, error: shipError(error) }

  revalidatePath(`/packing/${groupId}`)
  return { ok: true }
}

export async function setShipmentStatus(
  shipmentId: string,
  groupId: string,
  status: string,
): Promise<ActionResult> {
  const supabase = await createClient()
  const { error } = await supabase.rpc("set_shipment_status", {
    p_shipment_id: shipmentId,
    p_new_status: status,
  })
  if (error) return { ok: false, error: shipError(error) }

  revalidatePath(`/packing/${groupId}`)
  return { ok: true }
}

export async function removeShipment(
  shipmentId: string,
  groupId: string,
): Promise<ActionResult> {
  const supabase = await createClient()
  const { error } = await supabase
    .from("shipments")
    .delete()
    .eq("id", shipmentId)
  if (error) return { ok: false, error: shipError(error) }

  revalidatePath(`/packing/${groupId}`)
  return { ok: true }
}

export async function addPackage(
  shipmentId: string,
  groupId: string,
  fields: { trackingNumber?: string; cost?: string; weightGrams?: string },
): Promise<ActionResult> {
  const supabase = await createClient()
  const weight = optNum(fields.weightGrams)
  const { error } = await supabase.rpc("add_package", {
    p_shipment_id: shipmentId,
    p_tracking_number: fields.trackingNumber?.trim() || null,
    p_cost: optNum(fields.cost),
    p_weight_grams: weight === null ? null : Math.trunc(weight),
  })
  if (error) return { ok: false, error: shipError(error) }

  revalidatePath(`/packing/${groupId}`)
  return { ok: true }
}

export async function updatePackage(
  packageId: string,
  groupId: string,
  fields: { trackingNumber?: string; cost?: string; weightGrams?: string },
): Promise<ActionResult> {
  const supabase = await createClient()
  const weight = optNum(fields.weightGrams)
  const { error } = await supabase.rpc("update_package", {
    p_package_id: packageId,
    p_tracking_number: fields.trackingNumber?.trim() || null,
    p_cost: optNum(fields.cost),
    p_weight_grams: weight === null ? null : Math.trunc(weight),
  })
  if (error) return { ok: false, error: shipError(error) }

  revalidatePath(`/packing/${groupId}`)
  return { ok: true }
}

export async function removePackage(
  packageId: string,
  groupId: string,
): Promise<ActionResult> {
  const supabase = await createClient()
  const { error } = await supabase.from("packages").delete().eq("id", packageId)
  if (error) return { ok: false, error: shipError(error) }

  revalidatePath(`/packing/${groupId}`)
  return { ok: true }
}
