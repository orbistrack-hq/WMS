import { ArrowDown } from "lucide-react"
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
import { ReportsFilters } from "./reports-filters"
import { TrendChart, type TrendPoint } from "./trend-chart"
import { ExportButton } from "./export-button"

export const dynamic = "force-dynamic"

type SearchParams = {
  from?: string
  to?: string
  site?: string
  channel?: string
  dim?: string
  grain?: string
  bsort?: string
}

type MarginRow = {
  order_id: string
  order_number: string
  sale_date: string
  site_id: string
  site_name: string | null
  channel: string
  revenue: number | string
  discount: number | string
  product_cogs: number | string
  packaging_cost: number | string
  shipping_cost: number | string
  landed_cost: number | string
  gross_profit: number | string
  net_profit: number | string
}

const num = (v: number | string | null | undefined) => Number(v ?? 0)
const pct = (part: number, whole: number) =>
  whole === 0 ? "—" : `${((part / whole) * 100).toFixed(1)}%`

// Declared at module scope (not inside ReportsPage) so it isn't re-created on
// every render — react-hooks/static-components. Takes a ready-made href and
// active flag instead of closing over qs()/bsort.
function SortHead({
  label,
  href,
  active,
}: {
  label: string
  href: string
  active: boolean
}) {
  return (
    <Link
      href={href}
      className="inline-flex items-center justify-end gap-1 hover:text-foreground"
    >
      {label}
      {active ? <ArrowDown className="size-3" /> : null}
    </Link>
  )
}

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const sp = await searchParams
  const supabase = await createClient()

  const grain = sp.grain === "month" ? "month" : "day"
  const dim = sp.dim === "site" ? "site" : "channel"

  const { data: sites } = await supabase
    .from("sites")
    .select("id, name")
    .order("name")

  let query = supabase
    .from("landed_margin_report")
    .select(
      `order_id, order_number, sale_date, site_id, site_name, channel,
       revenue, discount, product_cogs, packaging_cost, shipping_cost,
       landed_cost, gross_profit, net_profit`,
    )
    .order("sale_date", { ascending: true })
    .limit(5000)

  if (sp.from) query = query.gte("sale_date", sp.from)
  if (sp.to) query = query.lte("sale_date", sp.to)
  if (sp.site) query = query.eq("site_id", sp.site)
  if (sp.channel) query = query.eq("channel", sp.channel)

  const { data, error } = await query
  const rows = (data ?? []) as unknown as MarginRow[]

  // ---- KPI totals ----------------------------------------------------------
  const t = rows.reduce(
    (acc, r) => {
      acc.revenue += num(r.revenue)
      acc.discount += num(r.discount)
      acc.productCogs += num(r.product_cogs)
      acc.packaging += num(r.packaging_cost)
      acc.shipping += num(r.shipping_cost)
      acc.landedCost += num(r.landed_cost)
      acc.grossProfit += num(r.gross_profit)
      acc.netProfit += num(r.net_profit)
      return acc
    },
    {
      revenue: 0,
      discount: 0,
      productCogs: 0,
      packaging: 0,
      shipping: 0,
      landedCost: 0,
      grossProfit: 0,
      netProfit: 0,
    },
  )
  const overhead = t.packaging + t.shipping

  const kpis = [
    { label: "Revenue", value: formatCurrency(t.revenue), sub: undefined, tone: "" },
    {
      label: "Product COGS",
      value: formatCurrency(t.productCogs),
      sub: `${pct(t.productCogs, t.revenue)} of revenue`,
      tone: "",
    },
    {
      label: "Packaging + shipping",
      value: formatCurrency(overhead),
      sub: `${pct(overhead, t.revenue)} of revenue`,
      tone: "",
    },
    {
      label: "Landed cost",
      value: formatCurrency(t.landedCost),
      sub: `${pct(t.landedCost, t.revenue)} of revenue`,
      tone: "",
    },
    {
      label: "Gross profit",
      value: formatCurrency(t.grossProfit),
      sub: `${pct(t.grossProfit, t.revenue)} product margin`,
      tone: "text-emerald-600 dark:text-emerald-400",
    },
    {
      label: "Net profit",
      value: formatCurrency(t.netProfit),
      sub: `${pct(t.netProfit, t.revenue)} net margin`,
      tone:
        t.netProfit >= 0
          ? "text-emerald-600 dark:text-emerald-400"
          : "text-destructive",
    },
  ]

  // ---- Trend series --------------------------------------------------------
  const trendMap = new Map<string, TrendPoint>()
  for (const r of rows) {
    const d = new Date(r.sale_date)
    const key = grain === "month" ? r.sale_date.slice(0, 7) : r.sale_date.slice(0, 10)
    const label =
      grain === "month"
        ? d.toLocaleDateString("en-US", { month: "short", year: "numeric" })
        : d.toLocaleDateString("en-US", { month: "short", day: "numeric" })
    const cur =
      trendMap.get(key) ?? { label, revenue: 0, landedCost: 0, netProfit: 0 }
    cur.revenue += num(r.revenue)
    cur.landedCost += num(r.landed_cost)
    cur.netProfit += num(r.net_profit)
    trendMap.set(key, cur)
  }
  const trend = [...trendMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, v]) => v)

  // ---- Breakdown by dimension ----------------------------------------------
  type BreakRow = {
    key: string
    label: string
    orders: number
    revenue: number
    productCogs: number
    overhead: number
    landedCost: number
    netProfit: number
  }
  const breakMap = new Map<string, BreakRow>()
  for (const r of rows) {
    const key = dim === "site" ? (r.site_name ?? "—") : r.channel
    const label =
      dim === "site"
        ? (r.site_name ?? "—")
        : r.channel.charAt(0).toUpperCase() + r.channel.slice(1)
    const cur =
      breakMap.get(key) ??
      {
        key,
        label,
        orders: 0,
        revenue: 0,
        productCogs: 0,
        overhead: 0,
        landedCost: 0,
        netProfit: 0,
      }
    cur.orders += 1
    cur.revenue += num(r.revenue)
    cur.productCogs += num(r.product_cogs)
    cur.overhead += num(r.packaging_cost) + num(r.shipping_cost)
    cur.landedCost += num(r.landed_cost)
    cur.netProfit += num(r.net_profit)
    breakMap.set(key, cur)
  }
  const bsort = (["revenue", "net_profit", "margin"] as const).includes(
    sp.bsort as never,
  )
    ? (sp.bsort as "revenue" | "net_profit" | "margin")
    : "revenue"
  const breakdown = [...breakMap.values()].sort((a, b) => {
    if (bsort === "net_profit") return b.netProfit - a.netProfit
    if (bsort === "margin")
      return b.netProfit / (b.revenue || 1) - a.netProfit / (a.revenue || 1)
    return b.revenue - a.revenue
  })

  // ---- CSV (per-order detail) ----------------------------------------------
  const csvColumns = [
    { key: "order_number", label: "Order" },
    { key: "sale_date", label: "Sale date" },
    { key: "site_name", label: "Site" },
    { key: "channel", label: "Channel" },
    { key: "revenue", label: "Revenue" },
    { key: "discount", label: "Discount" },
    { key: "product_cogs", label: "Product COGS" },
    { key: "packaging_cost", label: "Packaging" },
    { key: "shipping_cost", label: "Shipping" },
    { key: "landed_cost", label: "Landed cost" },
    { key: "gross_profit", label: "Gross profit" },
    { key: "net_profit", label: "Net profit" },
  ]

  const qs = (key: string) => {
    const next = new URLSearchParams()
    for (const [k, v] of Object.entries(sp)) if (v) next.set(k, v)
    next.set("bsort", key)
    return `?${next.toString()}`
  }

  return (
    <>
      <PageHeader
        title="Analytics"
        description="Revenue, COGS, and fully-landed margin for fulfilled orders — product cost plus allocated packaging and shipping."
        action={
          <ExportButton
            columns={csvColumns}
            rows={rows as unknown as Record<string, string | number | null>[]}
            filename="cogs-margin.csv"
          />
        }
      />

      <ReportsFilters sites={sites ?? []} />

      {error ? (
        <Card>
          <CardContent className="py-8 text-sm text-destructive">
            Could not load analytics: {error.message}
            <span className="mt-1 block text-muted-foreground">
              If this view is missing, apply migration 0027
              (landed_margin_report).
            </span>
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
            {kpis.map((k) => (
              <Card key={k.label}>
                <CardContent className="flex flex-col gap-0.5">
                  <span className="text-xs text-muted-foreground">
                    {k.label}
                  </span>
                  <span
                    className={`text-2xl font-semibold tabular-nums ${k.tone}`}
                  >
                    {k.value}
                  </span>
                  {k.sub ? (
                    <span className="text-xs text-muted-foreground">
                      {k.sub}
                    </span>
                  ) : null}
                </CardContent>
              </Card>
            ))}
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                Revenue, landed cost &amp; net profit
              </CardTitle>
            </CardHeader>
            <CardContent>
              <TrendChart data={trend} />
            </CardContent>
          </Card>

          <Card className="p-0">
            <CardHeader className="px-4 pt-4">
              <CardTitle className="text-base">
                By {dim === "site" ? "site" : "channel"}
              </CardTitle>
            </CardHeader>
            {breakdown.length === 0 ? (
              <CardContent className="py-8 text-sm text-muted-foreground">
                No fulfilled orders match these filters.
              </CardContent>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{dim === "site" ? "Site" : "Channel"}</TableHead>
                    <TableHead className="text-right">Orders</TableHead>
                    <TableHead className="text-right">
                      <SortHead
                        label="Revenue"
                        href={qs("revenue")}
                        active={bsort === "revenue"}
                      />
                    </TableHead>
                    <TableHead className="text-right">Product COGS</TableHead>
                    <TableHead className="text-right">Pkg + ship</TableHead>
                    <TableHead className="text-right">Landed cost</TableHead>
                    <TableHead className="text-right">
                      <SortHead
                        label="Net profit"
                        href={qs("net_profit")}
                        active={bsort === "net_profit"}
                      />
                    </TableHead>
                    <TableHead className="text-right">
                      <SortHead
                        label="Net margin"
                        href={qs("margin")}
                        active={bsort === "margin"}
                      />
                    </TableHead>
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
                        {formatCurrency(b.revenue)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {formatCurrency(b.productCogs)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {formatCurrency(b.overhead)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {formatCurrency(b.landedCost)}
                      </TableCell>
                      <TableCell
                        className={`text-right tabular-nums font-medium ${
                          b.netProfit >= 0 ? "" : "text-destructive"
                        }`}
                      >
                        {formatCurrency(b.netProfit)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {pct(b.netProfit, b.revenue)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
                <tfoot className="border-t bg-muted/40">
                  <TableRow className="hover:bg-transparent">
                    <TableCell className="font-medium">Total</TableCell>
                    <TableCell className="text-right tabular-nums font-medium">
                      {rows.length}
                    </TableCell>
                    <TableCell className="text-right tabular-nums font-medium">
                      {formatCurrency(t.revenue)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums font-medium">
                      {formatCurrency(t.productCogs)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums font-medium">
                      {formatCurrency(overhead)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums font-medium">
                      {formatCurrency(t.landedCost)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums font-medium">
                      {formatCurrency(t.netProfit)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums font-medium">
                      {pct(t.netProfit, t.revenue)}
                    </TableCell>
                  </TableRow>
                </tfoot>
              </Table>
            )}
          </Card>
        </div>
      )}
    </>
  )
}
