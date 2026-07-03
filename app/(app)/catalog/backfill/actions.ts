"use server"

import { revalidatePath } from "next/cache"

import { createClient } from "@/lib/supabase/server"
import { stripWeightSuffix } from "@/lib/catalog/weight"

type Ok<T> = { ok: true } & T
type Err = { ok: false; error: string }
export type Result<T> = Ok<T> | Err

type PgError = { message?: string; details?: string; code?: string } | null
function dbError(error: PgError): string {
  if (!error) return "Something went wrong."
  if (error.code === "42501") return "Admin access is required for this."
  return error.message || error.details || "Something went wrong."
}

export type BackfillChild = {
  siteId: string
  siteName: string
  onHand: number
}
export type BackfillMember = {
  productId: string
  productName: string
  grams: number
  children: BackfillChild[]
}
export type BackfillCollision = {
  siteName: string
  grams: number
  onHand: number
}
export type BackfillGroup = {
  strain: string
  canonicalExists: boolean
  members: BackfillMember[]
  weights: number[]
  childCount: number
  collisions: BackfillCollision[]
}

type ProductRow = {
  id: string
  name: string
  child_skus: {
    id: string
    site_id: string
    grams_per_unit: number | string | null
    is_active: boolean
    site: { name: string | null } | { name: string | null }[] | null
    inventory_levels:
      | { on_hand: number }
      | { on_hand: number }[]
      | null
  }[] | null
}

function one<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null)
}

/**
 * Detect flattened "Strain - Xg" products that should become weight-variant
 * children of one strain parent. Read-only: the actual move happens in
 * applyWeightBackfill via the guarded consolidate_weight_group RPC.
 */
export async function scanWeightBackfill(): Promise<
  Result<{ groups: BackfillGroup[] }>
> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from("products")
    .select(
      "id, name, child_skus(id, site_id, grams_per_unit, is_active, site:sites(name), inventory_levels(on_hand))",
    )
    .eq("is_active", true)
    .order("name")
  if (error) return { ok: false, error: dbError(error) }

  const products = (data ?? []) as unknown as ProductRow[]

  // Products already named exactly like a strain (no weight suffix) can serve as
  // the canonical parent.
  const plainNames = new Set(
    products
      .filter((p) => stripWeightSuffix(p.name).grams === null)
      .map((p) => p.name.trim().toLowerCase()),
  )

  const groups = new Map<string, BackfillGroup>()
  for (const p of products) {
    const { strain, grams } = stripWeightSuffix(p.name)
    if (grams === null) continue

    // Children that still need a weight (already-backfilled ones are skipped).
    const kids = (p.child_skus ?? []).filter(
      (c) => c.is_active && c.grams_per_unit == null,
    )
    if (kids.length === 0) continue

    const member: BackfillMember = {
      productId: p.id,
      productName: p.name,
      grams,
      children: kids.map((c) => ({
        siteId: c.site_id,
        siteName: one(c.site)?.name ?? "—",
        onHand: one(c.inventory_levels)?.on_hand ?? 0,
      })),
    }

    const key = strain.toLowerCase()
    const g =
      groups.get(key) ??
      ({
        strain,
        canonicalExists: plainNames.has(key),
        members: [],
        weights: [],
        childCount: 0,
        collisions: [],
      } as BackfillGroup)
    g.members.push(member)
    groups.set(key, g)
  }

  // Finalize each group: sort members, compute weights, detect collisions.
  const out: BackfillGroup[] = []
  for (const g of groups.values()) {
    g.members.sort((a, b) => a.grams - b.grams || a.productName.localeCompare(b.productName))
    const seen = new Set<string>()
    for (const m of g.members) {
      for (const c of m.children) {
        g.childCount++
        const k = `${c.siteId}|${m.grams}`
        if (seen.has(k)) {
          g.collisions.push({ siteName: c.siteName, grams: m.grams, onHand: c.onHand })
        } else {
          seen.add(k)
        }
      }
    }
    g.weights = Array.from(new Set(g.members.map((m) => m.grams))).sort(
      (a, b) => a - b,
    )
    out.push(g)
  }
  out.sort((a, b) => a.strain.localeCompare(b.strain))
  return { ok: true, groups: out }
}

export async function applyWeightBackfill(
  groups: { strain: string; members: { product_id: string; grams: number }[] }[],
): Promise<Result<{ moved: number; collisions: number; groups: number }>> {
  if (!groups.length) return { ok: false, error: "Select at least one group." }

  const supabase = await createClient()
  let moved = 0
  let collisions = 0
  for (const g of groups) {
    const { data, error } = await supabase.rpc("consolidate_weight_group", {
      p_strain: g.strain,
      p_members: g.members,
      p_dry_run: false,
    })
    if (error) return { ok: false, error: dbError(error) }
    const r = data as { moved: number; collisions: unknown[] }
    moved += Number(r.moved ?? 0)
    collisions += Array.isArray(r.collisions) ? r.collisions.length : 0
  }

  revalidatePath("/catalog")
  revalidatePath("/inventory/intake")
  return { ok: true, moved, collisions, groups: groups.length }
}
