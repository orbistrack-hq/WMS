import { PackageCheck } from "lucide-react"

import { createClient } from "@/lib/supabase/server"
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
    order_line_items: { quantity: number }[]
  }[]
  packaging_usage: { quantity: number; unit_cost_snapshot: number | string }[]
}

const ACTIVE = new Set(["created", "picking", "packed"])
const PREPACK = new Set(["created", "picking"])

export default async function PackingPage() {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("fulfillment_groups")
    .select(
      `id, status, window_start, site_id,
       customer:customers(name),
       site:sites(name),
       orders(id, order_number, status, order_line_items(quantity)),
       packaging_usage(quantity, unit_cost_snapshot)`,
    )
    .eq("status", "open")
    .is("dismissed_at", null)
    .order("window_start", { ascending: true })
    .limit(300)

  const groups: QueueGroup[] = ((data ?? []) as unknown as GroupRow[])
    .map((g) => {
      const activeOrders = g.orders.filter((o) => ACTIVE.has(o.status))
      const needsPacking = g.orders.some((o) => PREPACK.has(o.status))
      const itemCount = activeOrders.reduce(
        (n, o) =>
          n + o.order_line_items.reduce((s, li) => s + li.quantity, 0),
        0,
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
