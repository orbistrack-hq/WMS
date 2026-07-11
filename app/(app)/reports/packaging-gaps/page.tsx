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
import { formatCurrency } from "@/lib/format"
import { CHANNEL_LABEL, type OrderChannel } from "@/lib/orders/types"
import { ExportButton } from "../export-button"
import { PackagingGapsFilters } from "./packaging-gaps-filters"

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
}

const num = (v: number | string | null | undefined) => Number(v ?? 0)
const fmtDate = (v: string | null) =>
  v
    ? new Date(v).toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
      })
    : "—"

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
       line_count, unit_count, order_value, group_order_count`,
    )
    .order("fulfilled_at", { ascending: false })
    .limit(5000)

  if (sp.from) query = query.gte("fulfilled_at", sp.from)
  if (sp.to) query = query.lte("fulfilled_at", `${sp.to}T23:59:59.999`)
  if (sp.site) query = query.eq("site_id", sp.site)
  if (sp.channel) query = query.eq("channel", sp.channel)

  const { data, error } = await query
  const rows = (data ?? []) as unknown as GapRow[]

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
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Order</TableHead>
                    <TableHead>Fulfilled</TableHead>
                    <TableHead>Site</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead>Channel</TableHead>
                    <TableHead className="text-right">Units</TableHead>
                    <TableHead className="text-right">Value</TableHead>
                    <TableHead className="text-right">Pack</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.order_id}>
                      <TableCell className="font-medium">
                        {r.order_number}
                        {num(r.group_order_count) > 1 ? (
                          <span className="ml-1 text-xs text-muted-foreground">
                            (combined ×{num(r.group_order_count)})
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {fmtDate(r.fulfilled_at)}
                      </TableCell>
                      <TableCell>{r.site_name ?? "—"}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {r.customer_name ?? "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {CHANNEL_LABEL[r.channel as OrderChannel] ?? r.channel}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {num(r.unit_count)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCurrency(num(r.order_value))}
                      </TableCell>
                      <TableCell className="text-right">
                        <Link
                          href={`/packing/${r.group_id}`}
                          className="text-sm font-medium text-primary underline-offset-4 hover:underline"
                        >
                          Record
                        </Link>
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
