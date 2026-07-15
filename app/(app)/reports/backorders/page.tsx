import Link from "next/link"
import { PackageX } from "lucide-react"

import { createClient } from "@/lib/supabase/server"
import { PageHeader, Placeholder } from "@/components/page-header"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { formatDate } from "@/lib/format"
import { CHANNEL_LABEL, type OrderChannel } from "@/lib/orders/types"
import { ExportButton } from "../export-button"
import { BackorderFilters } from "./backorder-filters"

export const dynamic = "force-dynamic"

type SearchParams = { site?: string; channel?: string }

// One row per open backordered line (from the backorder_report view).
type BackorderRow = {
  line_id: string
  order_id: string
  order_number: string
  site_id: string
  site_name: string | null
  channel: OrderChannel
  status: string
  on_hold: boolean
  entered_at: string
  sale_date: string
  customer_name: string | null
  child_sku_id: string
  sku: string | null
  product_id: string
  product_name: string | null
  ordered_qty: number
  reserved_qty: number
  backordered_qty: number
  on_hand: number
  reserved_total: number
  available: number
}

export default async function BackordersReportPage({
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
    .from("backorder_report")
    .select(
      `line_id, order_id, order_number, site_id, site_name, channel, status,
       on_hold, entered_at, sale_date, customer_name, child_sku_id, sku,
       product_id, product_name, ordered_qty, reserved_qty, backordered_qty,
       on_hand, reserved_total, available`,
    )
    .order("entered_at", { ascending: true })
    .limit(10000)

  if (sp.site) query = query.eq("site_id", sp.site)
  if (sp.channel) query = query.eq("channel", sp.channel)

  const { data } = await query
  const rows = (data ?? []) as unknown as BackorderRow[]

  // ---- Per-SKU rollup: how many units we owe, and current shelf position -----
  const bySku = new Map<
    string,
    {
      key: string
      sku: string | null
      productName: string | null
      siteName: string | null
      unitsOwed: number
      orderIds: Set<string>
      onHand: number
      available: number
    }
  >()
  for (const r of rows) {
    // Same SKU can appear per site; key on child_sku_id (site-specific already).
    const key = r.child_sku_id
    const cur =
      bySku.get(key) ??
      {
        key,
        sku: r.sku,
        productName: r.product_name,
        siteName: r.site_name,
        unitsOwed: 0,
        orderIds: new Set<string>(),
        onHand: r.on_hand,
        available: r.available,
      }
    cur.unitsOwed += Number(r.backordered_qty)
    cur.orderIds.add(r.order_id)
    // Snapshot is identical across a SKU's rows; keep the latest read.
    cur.onHand = r.on_hand
    cur.available = r.available
    bySku.set(key, cur)
  }
  const skuRollup = Array.from(bySku.values()).sort(
    (a, b) => b.unitsOwed - a.unitsOwed,
  )

  const totalUnitsOwed = rows.reduce((s, r) => s + Number(r.backordered_qty), 0)
  const affectedOrders = new Set(rows.map((r) => r.order_id)).size

  // CSV mirrors the order-level detail (one row per backordered line).
  const exportRows = rows.map((r) => ({
    order_number: r.order_number,
    site: r.site_name ?? "",
    channel: CHANNEL_LABEL[r.channel] ?? r.channel,
    customer: r.customer_name ?? "",
    sku: r.sku ?? "",
    product: r.product_name ?? "",
    ordered: r.ordered_qty,
    reserved: r.reserved_qty,
    backordered: r.backordered_qty,
    on_hand: r.on_hand,
    available: r.available,
    entered: r.entered_at,
  }))
  const exportColumns = [
    { key: "order_number", label: "Order" },
    { key: "site", label: "Site" },
    { key: "channel", label: "Channel" },
    { key: "customer", label: "Customer" },
    { key: "sku", label: "SKU" },
    { key: "product", label: "Product" },
    { key: "ordered", label: "Ordered" },
    { key: "reserved", label: "Reserved" },
    { key: "backordered", label: "Backordered" },
    { key: "on_hand", label: "On hand" },
    { key: "available", label: "Available" },
    { key: "entered", label: "Entered" },
  ]

  return (
    <>
      <PageHeader
        title="Backorders"
        description="Open orders still awaiting stock — units owed per SKU and the orders waiting on them."
        action={
          <ExportButton
            columns={exportColumns}
            rows={exportRows}
            filename="backorders.csv"
          />
        }
      />

      <BackorderFilters sites={sites ?? []} />

      {rows.length === 0 ? (
        <Placeholder icon={PackageX} title="No backorders">
          Nothing is waiting on stock right now. Orders appear here when a line
          couldn&apos;t be fully reserved at creation.
        </Placeholder>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-3 text-sm">
            <Stat label="Units owed" value={totalUnitsOwed.toLocaleString()} />
            <Stat label="SKUs short" value={skuRollup.length.toLocaleString()} />
            <Stat
              label="Orders waiting"
              value={affectedOrders.toLocaleString()}
            />
          </div>

          {/* Units owed per SKU */}
          <Card>
            <CardHeader>
              <CardTitle>Units owed by SKU</CardTitle>
            </CardHeader>
            <CardContent className="px-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product</TableHead>
                    <TableHead>SKU</TableHead>
                    <TableHead>Site</TableHead>
                    <TableHead className="text-right">Owed</TableHead>
                    <TableHead className="text-right">Orders</TableHead>
                    <TableHead className="text-right">On hand</TableHead>
                    <TableHead className="text-right">Available</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {skuRollup.map((s) => (
                    <TableRow key={s.key}>
                      <TableCell className="font-medium">
                        {s.productName ?? "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {s.sku ?? "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {s.siteName ?? "—"}
                      </TableCell>
                      <TableCell className="text-right font-semibold tabular-nums text-amber-600">
                        {s.unitsOwed}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {s.orderIds.size}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {s.onHand}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {s.available}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {/* Order-level detail */}
          <Card>
            <CardHeader>
              <CardTitle>Backordered lines by order</CardTitle>
            </CardHeader>
            <CardContent className="px-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Order</TableHead>
                    <TableHead>Site</TableHead>
                    <TableHead>Channel</TableHead>
                    <TableHead>Product</TableHead>
                    <TableHead>SKU</TableHead>
                    <TableHead className="text-right">Ordered</TableHead>
                    <TableHead className="text-right">Reserved</TableHead>
                    <TableHead className="text-right">Backordered</TableHead>
                    <TableHead>Entered</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.line_id}>
                      <TableCell>
                        <Link
                          href={`/orders/${r.order_id}`}
                          className="font-medium hover:underline"
                        >
                          {r.order_number}
                        </Link>
                        {r.on_hold ? (
                          <Badge variant="destructive" className="ml-1.5">
                            Hold
                          </Badge>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {r.site_name ?? "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {CHANNEL_LABEL[r.channel] ?? r.channel}
                      </TableCell>
                      <TableCell className="font-medium">
                        {r.product_name ?? "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {r.sku ?? "—"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {r.ordered_qty}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {r.reserved_qty}
                      </TableCell>
                      <TableCell className="text-right font-semibold tabular-nums text-amber-600">
                        {r.backordered_qty}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatDate(r.entered_at)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>
      )}
    </>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border px-4 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
    </div>
  )
}
