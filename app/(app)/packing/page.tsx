import Link from "next/link"
import { Eye, EyeOff, PackageCheck } from "lucide-react"

import { createClient } from "@/lib/supabase/server"
import {
  childCountsByParent,
  qualifiesForWeightWarning,
} from "@/lib/catalog/missing-weight"
import { cn } from "@/lib/utils"
import { PageHeader } from "@/components/page-header"
import { buttonVariants } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { PackingQueue, type QueueGroup } from "./packing-queue"
import { DismissBefore } from "./dismiss-before"
import { HiddenGroups, type HiddenGroup } from "./hidden-groups"

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
    store_completed_at: string | null
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

type HiddenRow = {
  id: string
  window_start: string
  dismissed_at: string | null
  customer: { name: string | null } | null
  site: { name: string | null } | null
  orders: { id: string }[]
}

export default async function PackingPage({
  searchParams,
}: {
  searchParams: Promise<{ hidden?: string }>
}) {
  const supabase = await createClient()
  const showHidden = (await searchParams).hidden === "1"

  // Fetch every open, un-dismissed group that still has at least one active
  // order (created/picking/packed) that is NOT on hold. The !inner join + status
  // filter drops "dead" open groups — ones whose orders are all
  // fulfilled/cancelled but whose group never flipped to 'fulfilled' — which
  // otherwise pile up in the table. The on_hold filter enforces the hold's
  // "pause" semantics: a held order (e.g. awaiting payment clearance) keeps its
  // stock reserved but stays OUT of the packing queue until it's released.
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
       orders:orders!inner(id, order_number, status, store_completed_at,
         order_line_items(quantity,
           child_sku:child_skus(product_id, grams_per_unit, variant_label))),
       packaging_usage(quantity, unit_cost_snapshot)`,
    )
    .eq("status", "open")
    .is("dismissed_at", null)
    .in("orders.status", ["created", "picking", "packed"])
    .eq("orders.on_hold", false)
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
      // Any active order the store already marked completed — pack + close it.
      const storeCompleted = activeOrders.some(
        (o) => o.store_completed_at != null,
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
        storeCompleted,
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

  // How many open groups are currently hidden (dismissed). Cheap head count so
  // the "Show hidden" toggle can advertise that there's something to restore.
  const { count: hiddenCount } = await supabase
    .from("fulfillment_groups")
    .select("id", { count: "exact", head: true })
    .eq("status", "open")
    .not("dismissed_at", "is", null)

  // Only pull the full hidden list when the panel is open.
  let hidden: HiddenGroup[] = []
  if (showHidden) {
    const { data: hdata } = await supabase
      .from("fulfillment_groups")
      .select(
        `id, window_start, dismissed_at,
         customer:customers(name),
         site:sites(name),
         orders(id)`,
      )
      .eq("status", "open")
      .not("dismissed_at", "is", null)
      .order("dismissed_at", { ascending: false })

    hidden = ((hdata ?? []) as unknown as HiddenRow[]).map((g) => ({
      id: g.id,
      customer: g.customer?.name ?? "—",
      site: g.site?.name ?? "—",
      windowStart: g.window_start,
      dismissedAt: g.dismissed_at,
      orderCount: g.orders.length,
    }))
  }

  return (
    <>
      <PageHeader
        title="Packing"
        description="Pack orders by fulfillment group — box and label counted once per group, consumables summed. Select groups at one site to pick them as a wave."
      />

      <div className="flex flex-col gap-4">
        {/* Controls row: hide-before-a-date (only useful when there's a queue)
            and the Show/Hide-hidden toggle (always available, so a hidden group
            can be restored even when the queue is otherwise empty). */}
        <div className="flex flex-wrap items-center gap-2">
          {groups.length > 0 ? <DismissBefore /> : null}
          <Link
            href={showHidden ? "/packing" : "/packing?hidden=1"}
            className={cn(
              buttonVariants({
                variant: showHidden ? "default" : "outline",
                size: "sm",
              }),
              "ml-auto",
            )}
          >
            {showHidden ? (
              <Eye className="size-4" />
            ) : (
              <EyeOff className="size-4" />
            )}
            {showHidden
              ? "Hide hidden"
              : `Show hidden${hiddenCount ? ` (${hiddenCount})` : ""}`}
          </Link>
        </div>

        {showHidden ? <HiddenGroups groups={hidden} /> : null}

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
                Nothing to pack right now. New orders appear here as they come
                in.
              </p>
            </CardContent>
          </Card>
        ) : (
          <PackingQueue groups={groups} />
        )}
      </div>
    </>
  )
}
