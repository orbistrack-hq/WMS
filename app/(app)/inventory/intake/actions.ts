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

// ---- Step 6/7: per-child website sync status for a saved allocation --------
export type SyncStatus =
  | "done"
  | "pending"
  | "processing"
  | "failed"
  | "skipped"
  | "unmapped" // child has no store_variant_id
  | "off" // mapped, but its site's outbound sync is disabled (no job enqueued)

export type SyncStatusRow = {
  childId: string
  label: string
  siteName: string
  units: number
  status: SyncStatus
  detail: string | null
}

type LineChild = {
  id: string
  variant_label: string | null
  grams_per_unit: number | string
  store_variant_id: string | null
  site: { name: string | null } | null
}
type SyncLineRow = {
  units: number
  child: LineChild | LineChild[] | null
}
type JobRow = {
  child_sku_id: string
  status: string
  last_error: string | null
}

export async function getAllocationSyncStatus(
  allocationId: string,
): Promise<Result<{ rows: SyncStatusRow[] }>> {
  const supabase = await createClient()
  const { data: lineData, error } = await supabase
    .from("allocation_lines")
    .select(
      "units, child:child_skus(id, variant_label, grams_per_unit, store_variant_id, site:sites(name))",
    )
    .eq("allocation_id", allocationId)
  if (error) return { ok: false, error: rpcError(error) }

  const lines = (lineData ?? []) as unknown as SyncLineRow[]
  const children = lines
    .map((l) => (Array.isArray(l.child) ? l.child[0] : l.child))
    .filter((c): c is LineChild => Boolean(c))
  const ids = children.map((c) => c.id)

  // Latest outbound job per child (jobs table is keyed per child SKU).
  const latest = new Map<string, JobRow>()
  if (ids.length) {
    const { data: jobData } = await supabase
      .from("store_outbound_inventory_jobs")
      .select("child_sku_id, status, last_error, updated_at")
      .in("child_sku_id", ids)
      .order("updated_at", { ascending: false })
    for (const j of (jobData ?? []) as unknown as (JobRow & {
      updated_at: string
    })[]) {
      if (!latest.has(j.child_sku_id)) latest.set(j.child_sku_id, j)
    }
  }

  const rows: SyncStatusRow[] = lines.map((l) => {
    const c = Array.isArray(l.child) ? l.child[0] : l.child
    const grams = Number(c?.grams_per_unit ?? 0)
    const job = c ? latest.get(c.id) : undefined
    let status: SyncStatus
    let detail: string | null = null
    if (!c?.store_variant_id) status = "unmapped"
    else if (!job) status = "off"
    else {
      status = job.status as SyncStatus
      detail = job.last_error ?? null
    }
    return {
      childId: c?.id ?? "",
      label: c?.variant_label ?? `${grams}g`,
      siteName: c?.site?.name ?? "—",
      units: l.units,
      status,
      detail,
    }
  })
  return { ok: true, rows }
}

// ---- Undo: reverse an allocation or an intake (migration 0034) -------------
// Both are admin/operator-guarded in the DB. A business-rule block (e.g. units
// already reserved, or grams already allocated out) comes back as check_violation
// (23514) carrying a friendly message, which rpcError() surfaces verbatim.

export async function reverseAllocation(
  allocationId: string,
): Promise<Result<{ restoredGrams: number; childrenReversed: number }>> {
  if (!allocationId) return { ok: false, error: "No allocation specified." }
  const supabase = await createClient()
  const { data, error } = await supabase.rpc("reverse_allocation", {
    p_allocation_id: allocationId,
  })
  if (error) return { ok: false, error: rpcError(error) }
  // Reversal lowered each child's available -> push the correction downstream.
  await kickOutboundDrain()
  const r = data as { restored_grams: number; children_reversed: number }
  return {
    ok: true,
    restoredGrams: Number(r.restored_grams),
    childrenReversed: Number(r.children_reversed),
  }
}

export async function reverseIntake(
  ledgerId: string,
): Promise<Result<{ removedGrams: number; onHandGrams: number }>> {
  if (!ledgerId) return { ok: false, error: "No intake entry specified." }
  const supabase = await createClient()
  const { data, error } = await supabase.rpc("reverse_intake", {
    p_ledger_id: ledgerId,
  })
  if (error) return { ok: false, error: rpcError(error) }
  const r = data as { removed_grams: number; on_hand_grams: number }
  return {
    ok: true,
    removedGrams: Number(r.removed_grams),
    onHandGrams: Number(r.on_hand_grams),
  }
}
