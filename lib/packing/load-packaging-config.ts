import type { SupabaseClient } from "@supabase/supabase-js"

import type {
  PackagingOrderDefault,
  PackagingWeightRule,
} from "./packaging-rules"

// ---------------------------------------------------------------------------
// Load the weight→packaging config (FB-6, migration 0046) for computeOrderPackaging.
// Joins each rule/default to its packaging type's cost; inactive types are
// skipped so a deactivated type stops driving auto-packaging.
// ---------------------------------------------------------------------------

type TypeEmbed = {
  id: string
  name: string
  kind: string
  unit_cost: number | string
  is_active: boolean
} | null

const one = <T,>(v: T | T[] | null): T | null =>
  Array.isArray(v) ? (v[0] ?? null) : v

export type PackagingConfig = {
  weightRules: PackagingWeightRule[]
  orderDefaults: PackagingOrderDefault[]
}

export async function loadPackagingConfig(
  supabase: SupabaseClient,
): Promise<PackagingConfig> {
  const [rulesRes, defaultsRes] = await Promise.all([
    supabase
      .from("packaging_weight_rule")
      .select(
        "grams_per_unit, qty_per_unit, packaging_type:packaging_types(id, name, kind, unit_cost, is_active)",
      ),
    supabase
      .from("packaging_order_default")
      .select(
        "qty, packaging_type:packaging_types(id, name, kind, unit_cost, is_active)",
      ),
  ])

  const weightRules: PackagingWeightRule[] = []
  for (const r of (rulesRes.data ?? []) as unknown as {
    grams_per_unit: number | string
    qty_per_unit: number
    packaging_type: TypeEmbed | TypeEmbed[]
  }[]) {
    const t = one(r.packaging_type)
    if (!t || !t.is_active) continue
    weightRules.push({
      gramsPerUnit: Number(r.grams_per_unit),
      typeId: t.id,
      typeName: t.name,
      kind: t.kind,
      unitCost: Number(t.unit_cost),
      qtyPerUnit: r.qty_per_unit,
    })
  }

  const orderDefaults: PackagingOrderDefault[] = []
  for (const d of (defaultsRes.data ?? []) as unknown as {
    qty: number
    packaging_type: TypeEmbed | TypeEmbed[]
  }[]) {
    const t = one(d.packaging_type)
    if (!t || !t.is_active) continue
    orderDefaults.push({
      typeId: t.id,
      typeName: t.name,
      kind: t.kind,
      unitCost: Number(t.unit_cost),
      qty: d.qty,
    })
  }

  return { weightRules, orderDefaults }
}
