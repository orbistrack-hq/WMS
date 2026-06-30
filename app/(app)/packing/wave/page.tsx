import type { ReactNode } from "react"
import Link from "next/link"
import { ArrowLeft } from "lucide-react"

import { createClient } from "@/lib/supabase/server"
import { Card, CardContent } from "@/components/ui/card"
import {
  aggregateWave,
  type PickOrderRow,
  type WaveGroupInput,
} from "@/lib/packing/aggregate"
import { WaveView, type WaveRow } from "./wave-view"

export const dynamic = "force-dynamic"

type WaveGroupRow = {
  id: string
  status: string
  site_id: string | null
  customer: { name: string | null } | null
  site: { name: string | null } | null
  orders: PickOrderRow[]
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
  const { data, error } = await supabase
    .from("fulfillment_groups")
    .select(
      `id, status, site_id,
       customer:customers(name),
       site:sites(name),
       orders(order_number, status,
         order_line_items(quantity,
           child_sku:child_skus(id, sku, bin_location, barcode, product:products(name))))`,
    )
    .in("id", ids)
    .eq("status", "open")

  if (error) {
    return <Shell>Could not load the wave: {error.message}</Shell>
  }

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
    allocations: l.allocations.map((a) => ({
      groupId: a.groupId,
      groupLabel: a.groupLabel,
      orderNumber: a.orderNumber,
      qty: a.qty,
    })),
  }))

  // Dropped groups: selected but no longer open (packed/fulfilled/RLS).
  const droppedCount = ids.length - rows.length

  return (
    <WaveView
      siteName={rows[0]?.site?.name ?? null}
      groupCount={groupCount}
      orderCount={orderNumbers.length}
      totalUnits={totalUnits}
      droppedCount={droppedCount}
      rows={viewRows}
    />
  )
}
