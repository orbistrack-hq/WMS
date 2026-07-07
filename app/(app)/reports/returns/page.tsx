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
import { ReturnsFilters } from "./returns-filters"

export const dynamic = "force-dynamic"

type SearchParams = {
  from?: string
  to?: string
  site?: string
  channel?: string
}

type ReturnRow = {
  order_id: string
  order_number: string
  site_id: string
  site_name: string | null
  customer_name: string | null
  channel: string
  order_type: string
  entered_at: string
  sale_date: string
  returned_at: string | null
  line_count: number | string
  unit_count: number | string
  order_value: number | string
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

export default async function ReturnsReportPage({
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
    .from("returns_report")
    .select(
      `order_id, order_number, site_id, site_name, customer_name, channel,
       order_type, entered_at, sale_date, returned_at,
       line_count, unit_count, order_value`,
    )
    .order("returned_at", { ascending: false })
    .limit(5000)

  if (sp.from) query = query.gte("returned_at", sp.from)
  if (sp.to) query = query.lte("returned_at", `${sp.to}T23:59:59.999`)
  if (sp.site) query = query.eq("site_id", sp.site)
  if (sp.channel) query = query.eq("channel", sp.channel)

  const { data, error } = await query
  const rows = (data ?? []) as unknown as ReturnRow[]

  const totalOrders = rows.length
  const totalUnits = rows.reduce((n, r) => n + num(r.unit_count), 0)
  const totalValue = rows.reduce((n, r) => n + num(r.order_value), 0)

  // Breakdown by site — the client-facing "how many bounced" cut.
  type Break = { key: string; label: string; orders: number; units: number; value: number }
  const bySite = new Map<string, Break>()
  for (const r of rows) {
    const key = r.site_id
    const cur =
      bySite.get(key) ??
      { key, label: r.site_name ?? "—", orders: 0, units: 0, value: 0 }
    cur.orders += 1
    cur.units += num(r.unit_count)
    cur.value += num(r.order_value)
    bySite.set(key, cur)
  }
  const breakdown = [...bySite.values()].sort((a, b) => b.orders - a.orders)

  const csvColumns = [
    { key: "order_number", label: "Order" },
    { key: "returned_at", label: "Returned at" },
    { key: "site_name", label: "Site" },
    { key: "customer_name", label: "Customer" },
    { key: "channel", label: "Channel" },
    { key: "unit_count", label: "Units" },
    { key: "order_value", label: "Order value" },
    { key: "sale_date", label: "Sale date" },
  ]

  const kpis = [
    { label: "Bounced orders", value: String(totalOrders) },
    { label: "Units returned", value: String(totalUnits) },
    { label: "Value returned", value: formatCurrency(totalValue) },
  ]

  return (
    <>
      <PageHeader
        title="Returns"
        description="Orders that bounced back to us — restocked and logged, per site and channel. Share with clients to track return rates."
        action={
          <ExportButton
            columns={csvColumns}
            rows={rows as unknown as Record<string, string | number | null>[]}
            filename="returns.csv"
          />
        }
      />

      <ReturnsFilters sites={sites ?? []} />

      {error ? (
        <Card>
          <CardContent className="py-8 text-sm text-destructive">
            Could not load returns: {error.message}
            <span className="mt-1 block text-muted-foreground">
              If this view is missing, apply migration 0041 (returns_report).
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
              <CardTitle className="text-base">By site</CardTitle>
            </CardHeader>
            {breakdown.length === 0 ? (
              <CardContent className="py-8 text-sm text-muted-foreground">
                No returns match these filters.
              </CardContent>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Site</TableHead>
                    <TableHead className="text-right">Orders</TableHead>
                    <TableHead className="text-right">Units</TableHead>
                    <TableHead className="text-right">Value</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {breakdown.map((b) => (
                    <TableRow key={b.key}>
                      <TableCell className="font-medium">{b.label}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {b.orders}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {b.units}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCurrency(b.value)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Card>

          <Card className="p-0">
            <CardHeader className="px-4 pt-4">
              <CardTitle className="text-base">Returned orders</CardTitle>
            </CardHeader>
            {rows.length === 0 ? (
              <CardContent className="py-8 text-sm text-muted-foreground">
                No returns match these filters.
              </CardContent>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Order</TableHead>
                    <TableHead>Returned</TableHead>
                    <TableHead>Site</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead>Channel</TableHead>
                    <TableHead className="text-right">Units</TableHead>
                    <TableHead className="text-right">Value</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.order_id}>
                      <TableCell className="font-medium">
                        {r.order_number}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {fmtDate(r.returned_at)}
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
