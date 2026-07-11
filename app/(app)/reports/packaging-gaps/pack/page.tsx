import type { ReactNode } from "react"
import Link from "next/link"
import { ArrowLeft } from "lucide-react"

import { createClient } from "@/lib/supabase/server"
import { PageHeader } from "@/components/page-header"
import { Card, CardContent } from "@/components/ui/card"
import { loadPackagingConfig } from "@/lib/packing/load-packaging-config"
import {
  computeOrderPackaging,
  type WeightedUnit,
} from "@/lib/packing/packaging-rules"
import { MassPackView, type MassPackGroup, type PackTypeOption } from "./mass-pack-view"

export const dynamic = "force-dynamic"

type GroupRow = {
  id: string
  customer: { name: string | null } | null
  orders: {
    order_number: string | null
    order_line_items: {
      quantity: number
      child_sku: { grams_per_unit: number | string | null } | null
    }[]
  }[]
  packaging_usage: { quantity: number; unit_cost_snapshot: number | string }[]
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
          href="/reports/packaging-gaps"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" /> Back to packaging gaps
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

export default async function MassPackPage({
  searchParams,
}: {
  searchParams: Promise<{ groups?: string }>
}) {
  const ids = parseIds((await searchParams).groups)
  if (ids.length === 0) {
    return (
      <Shell>
        Select one or more orders on the packaging-gaps report, then choose
        &ldquo;Mass pack&rdquo; to record their packaging here.
      </Shell>
    )
  }

  const supabase = await createClient()
  const [groupsRes, typesRes, config] = await Promise.all([
    supabase
      .from("fulfillment_groups")
      .select(
        `id,
         customer:customers(name),
         orders(order_number,
           order_line_items(quantity, child_sku:child_skus(grams_per_unit))),
         packaging_usage(quantity, unit_cost_snapshot)`,
      )
      .in("id", ids),
    supabase
      .from("packaging_types")
      .select("id, name, kind, unit_cost")
      .eq("is_active", true)
      .order("kind"),
    loadPackagingConfig(supabase),
  ])

  if (groupsRes.error) {
    return <Shell>Could not load these groups: {groupsRes.error.message}</Shell>
  }

  const packagingTypes: PackTypeOption[] = (typesRes.data ?? []).map((t) => ({
    id: t.id,
    name: t.name,
    kind: t.kind,
    unitCost: Number(t.unit_cost),
  }))

  const rows = (groupsRes.data ?? []) as unknown as GroupRow[]

  const groups: MassPackGroup[] = rows.map((g) => {
    const units: WeightedUnit[] = []
    const orderNumbers: string[] = []
    for (const o of g.orders ?? []) {
      if (o.order_number) orderNumbers.push(o.order_number)
      for (const li of o.order_line_items ?? []) {
        const grams = li.child_sku?.grams_per_unit
        units.push({
          gramsPerUnit: grams == null ? null : Number(grams),
          qty: li.quantity,
        })
      }
    }
    const computed = computeOrderPackaging(
      units,
      config.weightRules,
      config.orderDefaults,
    )
    const existingCost = (g.packaging_usage ?? []).reduce(
      (s, u) => s + u.quantity * Number(u.unit_cost_snapshot),
      0,
    )
    return {
      groupId: g.id,
      label: g.customer?.name ?? `Group ${g.id.slice(0, 8)}`,
      orderNumbers: orderNumbers.sort(),
      seededLines: computed.lines.map((l) => ({
        typeId: l.typeId,
        typeName: l.typeName,
        kind: l.kind,
        unitCost: l.unitCost,
        qty: l.qty,
      })),
      unknownWeightUnits: computed.unknownWeightUnits,
      existingCost,
    }
  })

  // Newest gaps first (by order number) is fine; keep input order otherwise.
  groups.sort((a, b) =>
    (b.orderNumbers[0] ?? "").localeCompare(a.orderNumbers[0] ?? ""),
  )

  return (
    <>
      <PageHeader
        title="Mass pack — record packaging"
        description="Packaging is pre-filled per order from the weight rules (jars/bags by size + 1 box + 1 label per group). Adjust anything that's off, then record each group — or record them all at once. Counted once per group."
        action={
          <Link
            href="/reports/packaging-gaps"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-4" /> Back to gaps
          </Link>
        }
      />
      {groups.length === 0 ? (
        <Shell>None of the selected groups were found.</Shell>
      ) : (
        <MassPackView groups={groups} packagingTypes={packagingTypes} />
      )}
    </>
  )
}
