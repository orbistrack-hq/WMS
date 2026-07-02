"use server"

import { createClient } from "@/lib/supabase/server"
import { kickOutboundDrain } from "@/lib/store-sync/outbound"

// ---------------------------------------------------------------------------
// Intake + allocation actions — thin wrappers over the guarded RPCs
// (intake_receive, allocate_parent_stock from migration 0029). The RPCs own the
// validation, atomicity, and idempotency; these translate errors for operators.
// ---------------------------------------------------------------------------

type Ok<T> = { ok: true } & T
type Err = { ok: false; error: string }
export type Result<T> = Ok<T> | Err

type PgError = { message?: string; details?: string; code?: string } | null

function rpcError(error: PgError): string {
  if (!error) return "Something went wrong."
  // check_violation = a business-rule stop (over-allocation, bad UoM, etc.).
  if (error.code === "23514")
    return error.message || "That allocation isn't allowed."
  if (error.code === "42501") return "You don't have permission to do that."
  return error.message || error.details || "Something went wrong."
}

// ---- Step 2: receive bulk into the parent pool -----------------------------
export async function receiveIntake(input: {
  productId: string
  siteId: string
  qty: number
  uom: string
  batchNo?: string | null
  note?: string | null
}): Promise<Result<{ onHandGrams: number; receivedGrams: number }>> {
  if (!input.productId) return { ok: false, error: "Pick a parent SKU." }
  if (!input.siteId) return { ok: false, error: "Pick a receiving site." }
  if (!(input.qty > 0)) return { ok: false, error: "Quantity must be positive." }

  const supabase = await createClient()
  const { data, error } = await supabase.rpc("intake_receive", {
    p_product_id: input.productId,
    p_site_id: input.siteId,
    p_qty: input.qty,
    p_uom: input.uom,
    p_batch_no: input.batchNo?.trim() || null,
    p_note: input.note?.trim() || null,
  })
  if (error) return { ok: false, error: rpcError(error) }

  const r = data as { received_grams: number; on_hand_grams: number }
  return {
    ok: true,
    receivedGrams: Number(r.received_grams),
    onHandGrams: Number(r.on_hand_grams),
  }
}

// ---- Step 3 data: children of the parent, grouped by client (site) ---------
export type AllocationChild = {
  id: string
  label: string
  gramsPerUnit: number
  available: number
}
export type AllocationClient = {
  siteId: string
  siteName: string
  children: AllocationChild[]
}

type KidRow = {
  id: string
  site_id: string
  variant_label: string | null
  grams_per_unit: number | string
  site: { name: string | null } | null
  inventory_levels:
    | { available: number }
    | { available: number }[]
    | null
}

export async function loadAllocationTargets(
  productId: string,
  poolSiteId: string,
): Promise<Result<{ parentAvailableGrams: number; clients: AllocationClient[] }>> {
  const supabase = await createClient()
  const [poolRes, kidsRes] = await Promise.all([
    supabase
      .from("parent_inventory")
      .select("on_hand_grams")
      .eq("product_id", productId)
      .eq("site_id", poolSiteId)
      .maybeSingle(),
    supabase
      .from("child_skus")
      .select(
        "id, site_id, variant_label, grams_per_unit, site:sites(name), inventory_levels(available)",
      )
      .eq("product_id", productId)
      .eq("is_active", true)
      .not("grams_per_unit", "is", null),
  ])
  if (kidsRes.error) return { ok: false, error: rpcError(kidsRes.error) }

  const rows = (kidsRes.data ?? []) as unknown as KidRow[]
  const bySite = new Map<string, AllocationClient>()
  for (const k of rows) {
    const inv = Array.isArray(k.inventory_levels)
      ? k.inventory_levels[0]
      : k.inventory_levels
    const grams = Number(k.grams_per_unit)
    const client =
      bySite.get(k.site_id) ??
      ({
        siteId: k.site_id,
        siteName: k.site?.name ?? "—",
        children: [],
      } as AllocationClient)
    client.children.push({
      id: k.id,
      label: k.variant_label ?? `${grams}g`,
      gramsPerUnit: grams,
      available: inv?.available ?? 0,
    })
    bySite.set(k.site_id, client)
  }

  const clients = Array.from(bySite.values()).sort((a, b) =>
    a.siteName.localeCompare(b.siteName),
  )
  for (const c of clients)
    c.children.sort((a, b) => a.gramsPerUnit - b.gramsPerUnit)

  const pool = poolRes.data as { on_hand_grams: number | string } | null
  return {
    ok: true,
    parentAvailableGrams: Number(pool?.on_hand_grams ?? 0),
    clients,
  }
}

// ---- Step 5: save the allocation ------------------------------------------
export type AllocationResult = {
  allocation_id: string
  product_id: string
  site_id: string
  total_grams: number
  remaining_grams: number
  child_count: number
  replayed: boolean
}

export async function saveAllocation(input: {
  productId: string
  poolSiteId: string
  lines: { child_sku_id: string; units: number }[]
  idempotencyKey: string
  note?: string | null
}): Promise<Result<{ result: AllocationResult }>> {
  const lines = input.lines.filter((l) => l.units > 0)
  if (lines.length === 0)
    return { ok: false, error: "Enter at least one quantity to allocate." }

  const supabase = await createClient()
  const { data, error } = await supabase.rpc("allocate_parent_stock", {
    p_product_id: input.productId,
    p_site_id: input.poolSiteId,
    p_lines: lines,
    p_idempotency_key: input.idempotencyKey,
    p_note: input.note?.trim() || null,
  })
  if (error) return { ok: false, error: rpcError(error) }

  // Push each changed child's new available out to its client store (Step 6).
  await kickOutboundDrain()

  const r = data as AllocationResult
  return { ok: true, result: { ...r, total_grams: Number(r.total_grams), remaining_grams: Number(r.remaining_grams) } }
}
