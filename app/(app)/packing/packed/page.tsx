import Link from "next/link"
import { ArrowLeft, PackageCheck } from "lucide-react"

import { createClient } from "@/lib/supabase/server"
import { cn } from "@/lib/utils"
import { formatCurrency } from "@/lib/format"
import { PageHeader } from "@/components/page-header"
import { Badge } from "@/components/ui/badge"
import { buttonVariants } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

export const dynamic = "force-dynamic"

const PAGE_SIZE = 50

type GroupRow = {
  id: string
  window_start: string
  site_id: string | null
  customer: { name: string | null } | null
  site: { name: string | null } | null
  orders: {
    id: string
    order_number: string
    status: string
    store_completed_at: string | null
    order_line_items: { quantity: number }[]
  }[]
  packaging_usage: { quantity: number; unit_cost_snapshot: number | string }[]
}

// Groups whose orders are all packed (nothing left to pack) live here, off the
// active packing queue. A group with any order still created/picking stays on
// the main /packing screen instead.
export default async function PackedPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>
}) {
  const supabase = await createClient()
  const sp = await searchParams
  const page = Math.max(1, Number(sp.page ?? "1") || 1)
  const from = (page - 1) * PAGE_SIZE

  // Open, un-dismissed groups with at least one packed order. The embed is
  // filtered to packed orders; whether the group ALSO still needs packing is
  // resolved by a second query below (embeds can't express "not exists").
  const { data, error } = await supabase
    .from("fulfillment_groups")
    .select(
      `id, window_start, site_id,
       customer:customers(name),
       site:sites(name),
       orders:orders!inner(id, order_number, status, store_completed_at,
         order_line_items(quantity)),
       packaging_usage(quantity, unit_cost_snapshot)`,
    )
    .eq("status", "open")
    .is("dismissed_at", null)
    .eq("orders.status", "packed")
    .eq("orders.on_hold", false)
    .order("window_start", { ascending: false })
    .range(from, from + PAGE_SIZE)

  const fetched = (data ?? []) as unknown as GroupRow[]
  const hasMore = fetched.length > PAGE_SIZE
  const pageRows = fetched.slice(0, PAGE_SIZE)

  // Exclude any group that still has an order needing packing — those belong on
  // the main queue, not here.
  const ids = pageRows.map((g) => g.id)
  const stillPacking = new Set<string>()
  if (ids.length > 0) {
    const { data: pending } = await supabase
      .from("orders")
      .select("group_id")
      .in("group_id", ids)
      .in("status", ["created", "picking"])
    for (const r of (pending ?? []) as { group_id: string }[])
      stillPacking.add(r.group_id)
  }

  const groups = pageRows
    .filter((g) => !stillPacking.has(g.id))
    .map((g) => ({
      id: g.id,
      customer: g.customer?.name ?? "—",
      site: g.site?.name ?? "—",
      windowStart: g.window_start,
      orderNumbers: g.orders.map((o) => o.order_number),
      itemCount: g.orders.reduce(
        (n, o) => n + o.order_line_items.reduce((s, li) => s + li.quantity, 0),
        0,
      ),
      packagingCost: g.packaging_usage.reduce(
        (s, u) => s + u.quantity * Number(u.unit_cost_snapshot),
        0,
      ),
      storeCompleted: g.orders.some((o) => o.store_completed_at != null),
    }))

  return (
    <>
      <PageHeader
        title="Packed orders"
        description="Groups that are fully packed. They've left the active packing queue and stay here for reference."
      />

      <div className="flex flex-col gap-4">
        <div>
          <Link
            href="/packing"
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            <ArrowLeft className="size-4" />
            Back to packing
          </Link>
        </div>

        {error ? (
          <Card>
            <CardContent className="py-8 text-sm text-destructive">
              Could not load packed orders: {error.message}
            </CardContent>
          </Card>
        ) : groups.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
              <div className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
                <PackageCheck className="size-6" />
              </div>
              <p className="text-sm text-muted-foreground">
                No packed orders on this page.
              </p>
            </CardContent>
          </Card>
        ) : (
          <Card className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Customer</TableHead>
                  <TableHead>Site</TableHead>
                  <TableHead>Orders</TableHead>
                  <TableHead className="text-right">Items</TableHead>
                  <TableHead className="text-right">Packaging</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {groups.map((g) => (
                  <TableRow key={g.id}>
                    <TableCell className="font-medium">
                      <Link
                        href={`/packing/${g.id}`}
                        className="hover:underline"
                      >
                        {g.customer}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {g.site}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {g.orderNumbers.join(", ")}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {g.itemCount}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {formatCurrency(g.packagingCost)}
                    </TableCell>
                    <TableCell>
                      {g.storeCompleted ? (
                        <Badge variant="success">Completed at store</Badge>
                      ) : (
                        <Badge variant="secondary">Packed</Badge>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        )}

        {!error && (page > 1 || hasMore) ? (
          <div className="flex items-center justify-end gap-2 text-sm">
            <Link
              aria-disabled={page <= 1}
              href={`/packing/packed?page=${page - 1}`}
              className={cn(
                buttonVariants({ variant: "outline", size: "sm" }),
                page <= 1 && "pointer-events-none opacity-50",
              )}
            >
              Previous
            </Link>
            <span className="text-muted-foreground">Page {page}</span>
            <Link
              aria-disabled={!hasMore}
              href={`/packing/packed?page=${page + 1}`}
              className={cn(
                buttonVariants({ variant: "outline", size: "sm" }),
                !hasMore && "pointer-events-none opacity-50",
              )}
            >
              Next
            </Link>
          </div>
        ) : null}
      </div>
    </>
  )
}
