import Link from "next/link"

import { createClient } from "@/lib/supabase/server"
import { PageHeader } from "@/components/page-header"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { formatCurrency, formatDate } from "@/lib/format"
import { CHANNEL_LABEL, type OrderChannel } from "@/lib/orders/types"
import {
  childCountsByParent,
  qualifiesForWeightWarning,
} from "@/lib/catalog/missing-weight"
import { ExportButton } from "../export-button"
import { PackagingGapsFilters } from "./packaging-gaps-filters"
import { PackagingGapsTable } from "./packaging-gaps-table"

// ---------------------------------------------------------------------------
// Secondary section: packed/fulfilled orders that contain a line whose child
// SKU has NO weight. Those units couldn't be auto-classed into jars/bags at
// packing, so the group's consumable counts are short. Fix the weight in the
// catalog, then "Top up from weight" on the packing screen. Computed with a
// direct two-step query (no migration): find no-weight SKUs, then their lines
// on packed/fulfilled orders. RLS on both tables keeps it site-scoped.
// ---------------------------------------------------------------------------
type MissingWeightOrder = {
  orderId: string
  orderNumber: string
  siteName: string | null
  customerName: string | null
  channel: string
  status: string
  groupId: string | null
  fulfilledAt: string | null
  affectedUnits: number
}

async function loadPackedWithMissingWeights(
  supabase: Awaited<ReturnType<typeof createClient>>,
  sp: { from?: string; to?: string; site?: string; channel?: string },
): Promise<MissingWeightOrder[]> {
  // 1. No-weight child SKUs (null grams AND null variant label — a labelled
  //    null-weight item is an intentional non-weight variant, not a gap), kept
  //    only when the parent product sells by weight (≥2 child SKUs).
  const { data: skuRows } = await supabase
    .from("child_skus")
    .select("id, product_id")
    .is("grams_per_unit", null)
    .is("variant_label", null)
    .limit(5000)
  const noWeightSkus = (skuRows ?? []) as { id: string; product_id: string }[]
  if (noWeightSkus.length === 0) return []
  const parentCounts = await childCountsByParent(supabase, [
    ...new Set(noWeightSkus.map((r) => r.product_id)),
  ])
  const skuIds = noWeightSkus
    .filter((r) => qualifiesForWeightWarning(parentCounts.get(r.product_id) ?? 0))
    .map((r) => r.id)
  if (skuIds.length === 0) return []

  // 2. Their lines on packed/fulfilled orders, embedding the order for filters.
  let q = supabase
    .from("order_line_items")
    .select(
      `quantity, child_sku_id,
       order:orders!inner(id, order_number, site_id, channel, status,
         group_id, entered_at, fulfilled_at,
         site:sites(name), customer:customers(name))`,
    )
    .in("child_sku_id", skuIds)
    .in("order.status", ["packed", "fulfilled"])
    .limit(10000)

  if (sp.site) q = q.eq("order.site_id", sp.site)
  if (sp.channel) q = q.eq("order.channel", sp.channel)
  if (sp.from) q = q.gte("order.entered_at", sp.from)
  if (sp.to) q = q.lte("order.entered_at", `${sp.to}T23:59:59.999`)

  const { data } = await q
  type Row = {
    quantity: number
    order: {
      id: string
      order_number: string
      channel: string
      status: string
      group_id: string | null
      fulfilled_at: string | null
      site: { name: string | null } | null
      customer: { name: string | null } | null
    } | null
  }

  const byOrder = new Map<string, MissingWeightOrder>()
  for (const r of (data ?? []) as unknown as Row[]) {
    const o = r.order
    if (!o) continue
    const existing = byOrder.get(o.id)
    if (existing) existing.affectedUnits += r.quantity
    else
      byOrder.set(o.id, {
        orderId: o.id,
        orderNumber: o.order_number,
        siteName: o.site?.name ?? null,
        customerName: o.customer?.name ?? null,
        channel: o.channel,
        status: o.status,
        groupId: o.group_id,
        fulfilledAt: o.fulfilled_at,
        affectedUnits: r.quantity,
      })
  }
  return [...byOrder.values()].sort((a, b) =>
    b.orderNumber.localeCompare(a.orderNumber),
  )
}

export const dynamic = "force-dynamic"

type SearchParams = {
  from?: string
  to?: string
  site?: string
  channel?: string
}

type GapRow = {
  order_id: string
  order_number: string
  site_id: string
  site_name: string | null
  customer_name: string | null
  channel: string
  order_type: string
  group_id: string
  entered_at: string
  sale_date: string
  fulfilled_at: string | null
  line_count: number | string
  unit_count: number | string
  order_value: number | string
  group_order_count: number | string
  auto_fulfilled: boolean
}

const num = (v: number | string | null | undefined) => Number(v ?? 0)

export default async function PackagingGapsReportPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const sp = await searchParams
  const supabase = await createClient()

  const { data: sites } = await supabase
    .from("sites")
    .select("id, name")
    .order("name")

  let query = supabase
    .from("orders_missing_packaging")
    .select(
      `order_id, order_number, site_id, site_name, customer_name, channel,
       order_type, group_id, entered_at, sale_date, fulfilled_at,
       line_count, unit_count, order_value, group_order_count, auto_fulfilled`,
    )
    .order("fulfilled_at", { ascending: false })
    .limit(5000)

  if (sp.from) query = query.gte("fulfilled_at", sp.from)
  if (sp.to) query = query.lte("fulfilled_at", `${sp.to}T23:59:59.999`)
  if (sp.site) query = query.eq("site_id", sp.site)
  if (sp.channel) query = query.eq("channel", sp.channel)

  const { data, error } = await query
  const rows = (data ?? []) as unknown as GapRow[]

  const missingWeightOrders = await loadPackedWithMissingWeights(supabase, sp)

  const totalOrders = rows.length
  const totalUnits = rows.reduce((n, r) => n + num(r.unit_count), 0)
  const totalValue = rows.reduce((n, r) => n + num(r.order_value), 0)

  const csvColumns = [
    { key: "order_number", label: "Order" },
    { key: "fulfilled_at", label: "Fulfilled at" },
    { key: "site_name", label: "Site" },
    { key: "customer_name", label: "Customer" },
    { key: "channel", label: "Channel" },
    { key: "unit_count", label: "Units" },
    { key: "order_value", label: "Order value" },
    { key: "sale_date", label: "Sale date" },
  ]

  const kpis = [
    { label: "Orders missing packaging", value: String(totalOrders) },
    { label: "Units", value: String(totalUnits) },
    { label: "Order value", value: formatCurrency(totalValue) },
  ]

  return (
    <>
      <PageHeader
        title="Packaging gaps"
        description="Fulfilled Shopify/Woo orders whose packaging was never recorded — typically auto-fulfilled by a store webhook, skipping the packing screen. Record packaging from the packing screen to clear each one and capture its cost."
        action={
          <ExportButton
            columns={csvColumns}
            rows={rows as unknown as Record<string, string | number | null>[]}
            filename="packaging-gaps.csv"
          />
        }
      />

      <PackagingGapsFilters sites={sites ?? []} />

      {error ? (
        <Card>
          <CardContent className="py-8 text-sm text-destructive">
            Could not load packaging gaps: {error.message}
            <span className="mt-1 block text-muted-foreground">
              If this view is missing, apply migration 0062
              (orders_missing_packaging).
            </span>
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-3 gap-3">
            {kpis.map((k) => (
              <Card key={k.label}>
                <CardContent className="flex flex-col gap-0.5">
                  <span className="text-xs text-muted-foreground">
                    {k.label}
                  </span>
                  <span className="text-2xl font-semibold tabular-nums">
                    {k.value}
                  </span>
                </CardContent>
              </Card>
            ))}
          </div>

          <Card className="p-0">
            <CardHeader className="px-4 pt-4">
              <CardTitle className="text-base">
                Orders needing packaging
              </CardTitle>
            </CardHeader>
            {rows.length === 0 ? (
              <CardContent className="py-8 text-sm text-muted-foreground">
                No packaging gaps — every fulfilled store order has packaging
                recorded.
              </CardContent>
            ) : (
              <PackagingGapsTable rows={rows} />
            )}
          </Card>

          <Card className="p-0">
            <CardHeader className="px-4 pt-4">
              <CardTitle className="text-base">
                Packed with missing weights
              </CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">
                Packed or fulfilled orders that contain a line whose child SKU
                has no weight — their jars/bags couldn&rsquo;t be auto-filled, so
                the packaging counts are likely short. Set the weight in{" "}
                <Link href="/catalog?missing=true" className="underline">
                  Catalog
                </Link>
                , then open each order&rsquo;s group and press &ldquo;Top up from
                weight&rdquo;.
              </p>
            </CardHeader>
            {missingWeightOrders.length === 0 ? (
              <CardContent className="py-8 text-sm text-muted-foreground">
                None — every packed order has a weight on each line.
              </CardContent>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Order</TableHead>
                    <TableHead>Site</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead>Channel</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">No-weight units</TableHead>
                    <TableHead className="text-right">Fix</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {missingWeightOrders.map((o) => (
                    <TableRow key={o.orderId}>
                      <TableCell className="font-medium">
                        {o.orderNumber}
                      </TableCell>
                      <TableCell>{o.siteName ?? "—"}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {o.customerName ?? "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {CHANNEL_LABEL[o.channel as OrderChannel] ?? o.channel}
                      </TableCell>
                      <TableCell className="text-muted-foreground capitalize">
                        {o.status}
                        {o.fulfilledAt
                          ? ` · ${formatDate(o.fulfilledAt)}`
                          : ""}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {o.affectedUnits}
                      </TableCell>
                      <TableCell className="text-right">
                        {o.groupId ? (
                          <Link
                            href={`/packing/${o.groupId}`}
                            className="text-sm font-medium text-primary underline-offset-4 hover:underline"
                          >
                            Top up
                          </Link>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Card>
        </div>
      )}
    </>
  )
}
