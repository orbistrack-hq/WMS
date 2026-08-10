import { ArrowDown } from "lucide-react"
import Link from "next/link"

import { createClient } from "@/lib/supabase/server"
import { fetchAllPages } from "@/lib/supabase/fetch-all"
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

  // Paged, not `.limit()`. PostgREST caps at 1000 rows server-side and reports
  // no error when it truncates, so a `.limit(5000)` here quietly turned every
  // total on this page into "the oldest 1000 orders by sale_date" once volume
  // passed a thousand. Ordered by order_id (unique) rather than sale_date, since
  // sale_date has heavy ties and tied rows can shuffle between page requests,
  // duplicating some and dropping others. Sorting for display happens below.
  const buildQuery = () => {
    let q = supabase
      .from("landed_margin_report")
      .select(
        `order_id, order_number, sale_date, site_id, site_name, channel,
         revenue, discount, product_cogs, packaging_cost, shipping_cost,
         landed_cost, gross_profit, net_profit`,
      )
      .order("order_id")

    if (sp.from) q = q.gte("sale_date", sp.from)
    if (sp.to) q = q.lte("sale_date", sp.to)
    if (sp.site) q = q.eq("site_id", sp.site)
    if (sp.channel) q = q.eq("channel", sp.channel)
    return q
  }

  // Probe once so a missing view still renders the "apply migration 0027" hint.
  const { error } = await buildQuery().range(0, 0)
  const allRows = error ? [] : await fetchAllPages<MarginRow>(buildQuery)
  allRows.sort((a, b) => a.sale_date.localeCompare(b.sale_date))

  // ---- Promo orders --------------------------------------------------------
  // Influencer seeding / samples / gifts (migration 0091). They fulfil like any
  // other order — real product COGS, a real allocated share of packaging and
  // postage — but earn nothing by design, so leaving them in would make Net
  // profit read as a loss that isn't one and would slander whichever channel
  // they were entered under. They are pulled out of every profit figure below
  // and reported on their own "Promo cost" KPI as the marketing spend they are.
  //
  // Fetched as a separate id list rather than a column on landed_margin_report:
  // the flag lives on orders, and joining it in would mean redefining a view
  // that storefront_monthly_billing also reads. `.eq("is_promo", true)` means
  // only the flagged ids come back, not the whole order table.
  //
  // Paged for the same reason the margin query is: a bare select would stop at
  // PostgREST's silent 1000-row cap, and a truncated exclusion list is the worst
  // possible failure here — the promo orders past the cut would quietly rejoin
  // net profit with no error to notice. fetchAllPages also swallows a failed
  // query into [], so if migration 0091 hasn't been applied yet this degrades to
  // "no promo orders" — exactly the pre-0091 behaviour — rather than a 500.
  const promoIds = new Set(
    (
      await fetchAllPages<{ id: string }>(() =>
        supabase.from("orders").select("id").eq("is_promo", true).order("id"),
      )
    ).map((r) => r.id),
  )

  const rows = allRows.filter((r) => !promoIds.has(r.order_id))
  const promoRows = allRows.filter((r) => promoIds.has(r.order_id))

  // Promo orders are costed, never credited: their landed cost is the spend,
  // and any stray revenue on a partly-comped order is ignored here rather than
  // quietly netted off — the KPI answers "what did seeding cost us".
  const promoCost = promoRows.reduce((sum, r) => sum + num(r.landed_cost), 0)

  // ---- KPI totals (paying orders only) -------------------------------------
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

  // Only shown once there's something to show — an operation that never seeds
  // influencers shouldn't carry a permanent $0 tile.
  if (promoRows.length > 0) {
    kpis.push({
      label: "Promo cost",
      value: formatCurrency(promoCost),
      sub: `${promoRows.length} giveaway order${
        promoRows.length === 1 ? "" : "s"
      } — excluded above`,
      tone: "text-violet-600 dark:text-violet-400",
    })
  }

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
  // Money is rounded HERE, at the edge, not in the view. landed_margin_report
  // returns full precision on purpose (migration 0089) so that the totals above
  // are exact; an allocated share like 1.7528333 is correct arithmetic but
  // nonsense in a spreadsheet cell, so each row is formatted on the way out.
  //
  // The export keeps ALL rows, promo included, with an is_promo column — the
  // on-screen KPIs answer "how did we do", but a spreadsheet is where someone
  // reconciles against the books and needs to see every fulfilled order. The
  // column is what lets them re-split it the same way we did.
  const csvRows = allRows.map((r) => ({
    order_number: r.order_number,
    sale_date: r.sale_date,
    site_name: r.site_name ?? "",
    channel: r.channel,
    is_promo: promoIds.has(r.order_id) ? "yes" : "no",
    revenue: num(r.revenue).toFixed(2),
    discount: num(r.discount).toFixed(2),
    product_cogs: num(r.product_cogs).toFixed(2),
    packaging_cost: num(r.packaging_cost).toFixed(2),
    shipping_cost: num(r.shipping_cost).toFixed(2),
    landed_cost: num(r.landed_cost).toFixed(2),
    gross_profit: num(r.gross_profit).toFixed(2),
    net_profit: num(r.net_profit).toFixed(2),
  }))
  const csvColumns = [
    { key: "order_number", label: "Order" },
    { key: "sale_date", label: "Sale date" },
    { key: "site_name", label: "Site" },
    { key: "channel", label: "Channel" },
    { key: "is_promo", label: "Promo" },
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
        description={
          promoRows.length > 0
            ? "Revenue, COGS, and fully-landed margin for fulfilled orders — product cost plus allocated packaging and shipping. Promo/giveaway orders are excluded and shown as promo cost."
            : "Revenue, COGS, and fully-landed margin for fulfilled orders — product cost plus allocated packaging and shipping."
        }
        action={
          <ExportButton
            columns={csvColumns}
            rows={csvRows}
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
              {promoRows.length > 0 ? (
                <p className="text-xs text-muted-foreground">
                  {promoRows.length} promo order
                  {promoRows.length === 1 ? "" : "s"} (
                  {formatCurrency(promoCost)}) excluded — included in the CSV
                  export.
                </p>
              ) : null}
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
