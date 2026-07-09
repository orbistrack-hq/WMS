import type { ReactNode } from "react"
import Link from "next/link"
import { ArrowLeft } from "lucide-react"

import { createClient } from "@/lib/supabase/server"
import { Card, CardContent } from "@/components/ui/card"
import {
  aggregateWave,
  type PackagingTypeOption,
  type PickOrderRow,
  type WaveGroupInput,
} from "@/lib/packing/aggregate"
import { loadPackagingConfig } from "@/lib/packing/load-packaging-config"
import { WaveView, type WaveRow } from "./wave-view"

export const dynamic = "force-dynamic"

type WaveGroupRow = {
  id: string
  status: string
  site_id: string | null
  customer: { name: string | null } | null
  site: { name: string | null } | null
  orders: PickOrderRow[]
  packaging_usage: {
    quantity: number
    unit_cost_snapshot: number | string
    packaging_type_id: string
  }[]
}

function parseIds(raw: string | undefined): string[] {
  if (!raw) return []
  return [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))]
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <>
      <div className="mb-4">
        <Link
          href="/packing"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" /> Back to packing
        </Link>
      </div>
      <Card>
        <CardContent className="py-8 text-sm text-muted-foreground">
          {children}
        </CardContent>
      </Card>
    </>
  )
}

export default async function WavePage({
  searchParams,
}: {
  searchParams: Promise<{ groups?: string }>
}) {
  const ids = parseIds((await searchParams).groups)
  if (ids.length < 2) {
    return (
      <Shell>
        Pick at least two groups from the packing queue to build a wave.
      </Shell>
    )
  }

  const supabase = await createClient()
  const [groupsRes, typesRes, packagingConfig] = await Promise.all([
    supabase
      .from("fulfillment_groups")
      .select(
        `id, status, site_id,
         customer:customers(name),
         site:sites(name),
         orders(order_number, status,
           order_line_items(quantity,
             child_sku:child_skus(id, sku, bin_location, barcode, grams_per_unit, product:products(name)))),
         packaging_usage(quantity, unit_cost_snapshot, packaging_type_id)`,
      )
      .in("id", ids)
      .eq("status", "open")
      .is("dismissed_at", null),
    supabase
      .from("packaging_types")
      .select("id, name, kind, unit_cost")
      .eq("is_active", true)
      .order("kind"),
    // FB-6: weight→packaging map + per-order defaults (migration 0046) — same
    // config the per-order pack screen uses, so the wave seeds identical per-type
    // packaging (Mylar sizes, one vacuum bag / box / label per order).
    loadPackagingConfig(supabase),
  ])
  const { data, error } = groupsRes

  if (error) {
    return <Shell>Could not load the wave: {error.message}</Shell>
  }

  const packagingTypes: PackagingTypeOption[] = (typesRes.data ?? []).map(
    (t) => ({
      id: t.id,
      name: t.name,
      kind: t.kind,
      unit_cost: Number(t.unit_cost),
    }),
  )

  const rows = (data ?? []) as unknown as WaveGroupRow[]
  if (rows.length === 0) {
    return (
      <Shell>
        None of the selected groups are still open for picking. They may have
        been packed or fulfilled — head back and rebuild the wave.
      </Shell>
    )
  }

  // A wave is one walking route, so it must stay within a single site.
  const siteIds = new Set(rows.map((g) => g.site_id))
  if (siteIds.size > 1) {
    return (
      <Shell>
        Those groups span more than one site. A wave covers one site at a time —
        go back and select groups from the same site.
      </Shell>
    )
  }

  const waveGroups: WaveGroupInput[] = rows.map((g) => ({
    id: g.id,
    label: g.customer?.name ?? `Group ${g.id.slice(0, 8)}`,
    orders: g.orders,
  }))

  const { lines, groupCount, orderNumbers, totalUnits } =
    aggregateWave(waveGroups)

  const viewRows: WaveRow[] = lines.map((l) => ({
    childSkuId: l.childSkuId,
    sku: l.sku,
    bin: l.bin,
    name: l.name,
    qty: l.qty,
    gramsPerUnit: l.gramsPerUnit,
    allocations: l.allocations.map((a) => ({
      groupId: a.groupId,
      groupLabel: a.groupLabel,
      orderNumber: a.orderNumber,
      qty: a.qty,
    })),
  }))

  // Dropped groups: selected but no longer open (packed/fulfilled/RLS).
  const droppedCount = ids.length - rows.length

  // Existing packaging cost per group — groups that already have lines
  // (entered on their own pack screen) skip the mass-pack defaults so we
  // never double-count a box/label that's already been recorded.
  const existingPackaging: Record<string, number> = {}
  for (const g of rows) {
    existingPackaging[g.id] = g.packaging_usage.reduce(
      (s, u) => s + u.quantity * Number(u.unit_cost_snapshot),
      0,
    )
  }

  return (
    <WaveView
      siteName={rows[0]?.site?.name ?? null}
      groupCount={groupCount}
      orderCount={orderNumbers.length}
      totalUnits={totalUnits}
      droppedCount={droppedCount}
      rows={viewRows}
      packagingTypes={packagingTypes}
      existingPackaging={existingPackaging}
      weightRules={packagingConfig.weightRules}
      orderDefaults={packagingConfig.orderDefaults}
    />
  )
}
