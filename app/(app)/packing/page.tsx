import { PackageCheck } from "lucide-react"

import { createClient } from "@/lib/supabase/server"
import {
  childCountsByParent,
  qualifiesForWeightWarning,
} from "@/lib/catalog/missing-weight"
import { PageHeader } from "@/components/page-header"
import { Card, CardContent } from "@/components/ui/card"
import { PackingQueue, type QueueGroup } from "./packing-queue"
import { DismissBefore } from "./dismiss-before"

export const dynamic = "force-dynamic"

type GroupRow = {
  id: string
  status: string
  window_start: string
  site_id: string | null
  customer: { name: string | null } | null
  site: { name: string | null } | null
  orders: {
    id: string
    order_number: string
    status: string
    order_line_items: {
      quantity: number
      child_sku: {
        product_id: string
        grams_per_unit: number | string | null
        variant_label: string | null
      } | null
    }[]
  }[]
  packaging_usage: { quantity: number; unit_cost_snapshot: number | string }[]
}

const ACTIVE = new Set(["created", "picking", "packed"])
const PREPACK = new Set(["created", "picking"])

export default async function PackingPage() {
  const supabase = await createClient()

  // Fetch every open, un-dismissed group that still has at least one active
  // order (created/picking/packed). The !inner join + status filter drops
  // "dead" open groups — ones whose orders are all fulfilled/cancelled but whose
  // group never flipped to 'fulfilled' — which otherwise pile up in the table.
  //
  // NO row limit: the queue must always surface the newest work. The previous
  // `.order(window_start asc).limit(300)` truncated to the oldest 300 open
  // groups, so once dead groups accumulated past 300 the latest orders silently
  // fell off the queue. Bounding the fetch to active groups keeps the result set
  // to real packing work, so an unbounded fetch is safe.
  const { data, error } = await supabase
    .from("fulfillment_groups")
    .select(
      `id, status, window_start, site_id,
       customer:customers(name),
       site:sites(name),
       orders:orders!inner(id, order_number, status,
         order_line_items(quantity,
           child_sku:child_skus(product_id, grams_per_unit, variant_label))),
       packaging_usage(quantity, unit_cost_snapshot)`,
    )
    .eq("status", "open")
    .is("dismissed_at", null)
    .in("orders.status", ["created", "picking", "packed"])
    .order("window_start", { ascending: true })

  const rows = (data ?? []) as unknown as GroupRow[]

  // A no-weight line only warrants a badge when its parent product carries ≥2
  // child SKUs (single-child products often have no weight on purpose). Collect
  // the parents of every active no-weight line, then count their children once.
  const candidateParentIds = new Set<string>()
  for (const g of rows) {
    for (const o of g.orders) {
      if (!ACTIVE.has(o.status)) continue
      for (const li of o.order_line_items) {
        const cs = li.child_sku
        if (cs && cs.grams_per_unit == null && !cs.variant_label)
          candidateParentIds.add(cs.product_id)
      }
    }
  }
  const parentCounts = await childCountsByParent(supabase, [
    ...candidateParentIds,
  ])
  const parentQualifies = (productId: string) =>
    qualifiesForWeightWarning(parentCounts.get(productId) ?? 0)

  const groups: QueueGroup[] = rows
    .map((g) => {
      const activeOrders = g.orders.filter((o) => ACTIVE.has(o.status))
      const needsPacking = g.orders.some((o) => PREPACK.has(o.status))
      const itemCount = activeOrders.reduce(
        (n, o) =>
          n + o.order_line_items.reduce((s, li) => s + li.quantity, 0),
        0,
      )
      // Any active line whose child SKU has no weight (and no intentional
      // variant label) AND whose parent sells by weight (≥2 child SKUs) — its
      // jars/bags can't be auto-filled at packing.
      const needsWeight = activeOrders.some((o) =>
        o.order_line_items.some(
          (li) =>
            li.child_sku != null &&
            li.child_sku.grams_per_unit == null &&
            !li.child_sku.variant_label &&
            parentQualifies(li.child_sku.product_id),
        ),
      )
      const packagingCost = g.packaging_usage.reduce(
        (s, u) => s + u.quantity * Number(u.unit_cost_snapshot),
        0,
      )
      return {
        id: g.id,
        siteId: g.site_id,
        customer: g.customer?.name ?? "—",
        site: g.site?.name ?? "—",
        windowStart: g.window_start,
        orderNumbers: activeOrders.map((o) => o.order_number),
        orderCount: activeOrders.length,
        itemCount,
        packagingCost,
        needsPacking,
        needsWeight,
      }
    })
    .filter((g) => g.orderCount > 0)
    // Needs-packing first, then by fewest orders.
    .sort((a, b) =>
      a.needsPacking === b.needsPacking
        ? a.orderCount - b.orderCount
        : a.needsPacking
          ? -1
          : 1,
    )

  return (
    <>
      <PageHeader
        title="Packing"
        description="Pack orders by fulfillment group — box and label counted once per group, consumables summed. Select groups at one site to pick them as a wave."
      />

      {error ? (
        <Card>
          <CardContent className="py-8 text-sm text-destructive">
            Could not load packing queue: {error.message}
          </CardContent>
        </Card>
      ) : groups.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <div className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <PackageCheck className="size-6" />
            </div>
            <p className="text-sm text-muted-foreground">
              Nothing to pack right now. New orders appear here as they come in.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          <DismissBefore />
          <PackingQueue groups={groups} />
        </div>
      )}
    </>
  )
}
