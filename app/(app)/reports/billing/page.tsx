import Link from "next/link"
import { Receipt, TriangleAlert } from "lucide-react"

import { createClient } from "@/lib/supabase/server"
import { PageHeader, Placeholder } from "@/components/page-header"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatCurrency, todayISODate } from "@/lib/format"
import { ExportButton } from "../export-button"
import { CopyTableButton } from "../copy-table-button"
import { BillingFilters } from "./billing-filters"
import { BackfillPickFeesButton } from "./backfill-pick-fees-button"

export const dynamic = "force-dynamic"

type SearchParams = { from?: string; to?: string; site?: string }

/**
 * Per-brand fulfilment billing for a period — what each brand owes us.
 *
 * Reads the migration-0030 views plus the pick-fee ledger. That migration built
 * the cost side and said outright that the invoice / paid-unpaid layer was "a
 * deliberate later phase"; until that phase lands, the person doing billing
 * exports this grid and pastes it into the Fulfillment Payment Tracker
 * workbook, which holds invoice numbers and paid status. The CSV column order
 * matches that workbook's Invoices sheet (columns B–J) so it is a clean paste
 * with no rearranging — do not reorder exportColumns without updating it.
 *
 * THREE COSTS, TWO GRAINS:
 *   postage + packaging  live at the FULFILLMENT GROUP grain (one row per group
 *                        in storefront_fulfillment_cost)
 *   pick fees            live at the ORDER grain (billing_charges, snapshotted
 *                        at fulfilment with the fee schedule that was in force)
 * They cannot be summed in one pass without fanning out, so each is rolled up
 * to the brand separately and then merged on site_id.
 *
 * POSTAGE IS SEPARATE ON PURPOSE. It is a pass-through reimbursement; packaging
 * and picking are the service charge. Brands are billed on one basis or the
 * other, so both totals are shown and both go into the CSV.
 *
 * DATES ARE PACIFIC. The app is Pacific end-to-end (migration 0055). Period
 * bounds are compared against billing_date (already a date) and against
 * fulfilled_at rendered in the app zone — never the host's UTC — or an order
 * fulfilled after 5pm on the last of the month lands in the wrong invoice.
 */

type CostRow = {
  group_id: string
  site_id: string
  site_name: string | null
  channel: string
  storefront: string | null
  billing_date: string
  group_status: string
  channel_count: number
  shipping_cost: number | string
  packaging_cost: number | string
}

const STORE_CHANNELS = new Set(["shopify", "woocommerce"])

type ChargeRow = {
  amount: number | string
  order_id: string
  orders: {
    id: string
    site_id: string
    status: string
    fulfilled_at: string | null
    sale_date: string
  } | null
}

type OrderRow = {
  id: string
  order_number: string
  site_id: string
  fulfilled_at: string | null
  sale_date: string
}

const num = (v: number | string | null | undefined) => Number(v ?? 0)

/**
 * The UTC instant at which a Pacific calendar day starts (or ends).
 *
 * Needed because fulfilled_at is a timestamptz and the period bounds are
 * Pacific calendar dates. The offset is read from the runtime's tz database for
 * that specific date rather than hardcoded, so the PST/PDT switch is handled —
 * a fixed -08:00 would silently shift every summer month by an hour and move
 * orders across the month boundary.
 */
function pacificBound(day: string, edge: "start" | "end"): string {
  const probe = new Date(`${day}T12:00:00Z`)
  const offset =
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      timeZoneName: "longOffset",
    })
      .formatToParts(probe)
      .find((p) => p.type === "timeZoneName")?.value ?? "GMT-08:00"
  const sign = offset.includes("-") ? "-" : "+"
  const hhmm = offset.replace(/^GMT[+-]?/, "") || "08:00"
  const time = edge === "start" ? "00:00:00.000" : "23:59:59.999"
  return new Date(`${day}T${time}${sign}${hhmm}`).toISOString()
}

const ROW_LIMIT = 20000

function defaultRange() {
  const today = todayISODate()
  const [y, m] = today.split("-")
  const last = new Date(Number(y), Number(m), 0).getDate()
  return { from: `${y}-${m}-01`, to: `${y}-${m}-${String(last).padStart(2, "0")}` }
}

export default async function BillingReportPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const sp = await searchParams
  const supabase = await createClient()

  const fallback = defaultRange()
  const from = sp.from || fallback.from
  const to = sp.to || fallback.to

  const { data: sites } = await supabase.from("sites").select("id, name").order("name")

  // --- Postage + packaging, group grain ------------------------------------
  let costQ = supabase
    .from("storefront_fulfillment_cost")
    .select(
      `group_id, site_id, site_name, channel, storefront, billing_date,
       group_status, channel_count, shipping_cost, packaging_cost`,
    )
    .gte("billing_date", from)
    .lte("billing_date", to)
    .limit(20000)
  if (sp.site) costQ = costQ.eq("site_id", sp.site)

  // Both order-grain queries are bounded by the period IN THE DATABASE.
  //
  // They used to fetch up to the row limit and filter to the period in JS. That
  // is unsound: the limit applies before the filter, and the two queries
  // truncate independently, so an order could survive the cut while its pick-fee
  // charge did not — reporting an order as unbilled when it was billed fine.
  // Filtering server-side means each query returns only the period's rows, and
  // the two sets are guaranteed to describe the same orders.
  const fromTs = pacificBound(from, "start")
  const toTs = pacificBound(to, "end")

  // --- Pick fees, order grain ----------------------------------------------
  // !inner so a charge whose order is missing/cancelled drops out server-side.
  let chargeQ = supabase
    .from("billing_charges")
    .select(`amount, order_id, orders!inner(id, site_id, status, fulfilled_at, sale_date)`)
    .eq("fee_type", "pick_fee")
    .neq("orders.status", "cancelled")
    .gte("orders.fulfilled_at", fromTs)
    .lte("orders.fulfilled_at", toTs)
    .limit(ROW_LIMIT)
  if (sp.site) chargeQ = chargeQ.eq("orders.site_id", sp.site)

  // --- Fulfilled orders in the window, to catch ones we never charged for ---
  let orderQ = supabase
    .from("orders")
    .select("id, order_number, site_id, fulfilled_at, sale_date")
    .eq("status", "fulfilled")
    .gte("fulfilled_at", fromTs)
    .lte("fulfilled_at", toTs)
    .limit(ROW_LIMIT)
  if (sp.site) orderQ = orderQ.eq("site_id", sp.site)

  const [{ data: costData }, { data: chargeData }, { data: orderData }] = await Promise.all([
    costQ,
    chargeQ,
    orderQ,
  ])

  // storefront_fulfillment_cost carries every group that isn't cancelled, which
  // includes OPEN ones — orders picked up by the window but not yet packed. They
  // have no packaging because nobody has packed them, and billing a brand for an
  // order that hasn't shipped would be wrong, so only fulfilled groups are
  // billable. Open groups are counted separately and disclosed, never silently
  // dropped: a brand asking "why is this month low" deserves the number.
  const allCostRows = (costData ?? []) as unknown as CostRow[]
  const costRows = allCostRows.filter((r) => r.group_status === "fulfilled")
  const openGroups = allCostRows.filter((r) => r.group_status !== "fulfilled")
  // Date filtering for the two order-grain queries happens here rather than in
  // PostgREST: the billable day is a Pacific-rendered timestamp with a fallback,
  // which no single column filter expresses.
  const chargeRows = ((chargeData ?? []) as unknown as ChargeRow[]).filter((c) => Boolean(c.orders))
  const orderRows = (orderData ?? []) as unknown as OrderRow[]

  // If any query came back exactly full, it was cut off and the numbers below
  // are understated. Better to say so than to quietly invoice a partial period.
  const truncated =
    allCostRows.length >= ROW_LIMIT ||
    chargeRows.length >= ROW_LIMIT ||
    orderRows.length >= ROW_LIMIT

  // --- Units per billed order ----------------------------------------------
  // Chunked so a long period cannot blow past the URL length limit on .in().
  const billedOrderIds = Array.from(new Set(chargeRows.map((c) => c.order_id)))
  const unitsByOrder = new Map<string, number>()
  for (let i = 0; i < billedOrderIds.length; i += 300) {
    const chunk = billedOrderIds.slice(i, i + 300)
    const { data } = await supabase
      .from("order_line_items")
      .select("order_id, quantity")
      .in("order_id", chunk)
    for (const li of (data ?? []) as { order_id: string; quantity: number }[]) {
      unitsByOrder.set(li.order_id, (unitsByOrder.get(li.order_id) ?? 0) + num(li.quantity))
    }
  }

  // --- Roll both grains up to the brand ------------------------------------
  type Brand = {
    siteId: string
    name: string
    channel: string
    storefront: string | null
    groups: number
    orders: number
    units: number
    postage: number
    packaging: number
    pickFees: number
  }
  const brands = new Map<string, Brand>()
  const get = (siteId: string, name: string | null): Brand => {
    const cur = brands.get(siteId) ?? {
      siteId,
      name: name ?? "—",
      channel: "manual",
      storefront: null,
      groups: 0,
      orders: 0,
      units: 0,
      postage: 0,
      packaging: 0,
      pickFees: 0,
    }
    brands.set(siteId, cur)
    return cur
  }

  for (const r of costRows) {
    const b = get(r.site_id, r.site_name)
    b.channel = r.channel
    b.storefront = r.storefront
    b.groups += 1
    b.postage += num(r.shipping_cost)
    b.packaging += num(r.packaging_cost)
  }
  for (const c of chargeRows) {
    if (!c.orders) continue
    const b = get(c.orders.site_id, null)
    b.orders += 1
    b.pickFees += num(c.amount)
    b.units += unitsByOrder.get(c.order_id) ?? 0
  }
  // A brand seen only via pick fees has no name yet; backfill from sites.
  const siteName = new Map((sites ?? []).map((s) => [s.id, s.name]))
  for (const b of brands.values()) {
    if (b.name === "—") b.name = siteName.get(b.siteId) ?? "—"
  }

  const rows = Array.from(brands.values()).sort((a, b) => a.name.localeCompare(b.name))

  const t = rows.reduce(
    (acc, b) => {
      acc.groups += b.groups
      acc.orders += b.orders
      acc.units += b.units
      acc.postage += b.postage
      acc.packaging += b.packaging
      acc.pickFees += b.pickFees
      return acc
    },
    { groups: 0, orders: 0, units: 0, postage: 0, packaging: 0, pickFees: 0 },
  )
  const serviceTotal = t.packaging + t.pickFees
  const grandTotal = serviceTotal + t.postage

  // --- Under-billing checks -------------------------------------------------
  // Both are money we earned and would otherwise invoice short.
  const chargedIds = new Set(chargeRows.map((c) => c.order_id))
  const missingPickFee = orderRows.filter((o) => !chargedIds.has(o.id))
  // Only FULFILLED groups can have a packaging gap. Split by channel because the
  // two halves are cleared in different places: the Packaging gaps report covers
  // store-channel orders only (migration 0062 scopes it to shopify/woocommerce),
  // so a manual-channel gap will never show up there and has to be cleared on
  // the packing screen. Sending someone to an empty report is how they conclude
  // the warning is broken and start ignoring it.
  const gaps = costRows.filter((r) => num(r.packaging_cost) === 0)
  const storeGaps = gaps.filter((r) => STORE_CHANNELS.has(r.channel))
  const manualGaps = gaps.filter((r) => !STORE_CHANNELS.has(r.channel))
  const mixedChannel = costRows.filter((r) => Number(r.channel_count) > 1)

  const periodLabel = from.slice(0, 7) === to.slice(0, 7) ? from.slice(0, 7) : `${from} to ${to}`

  // CSV column order mirrors the tracker's Invoices sheet, columns B–J.
  const exportRows = rows.map((b) => ({
    brand: b.name,
    period_start: from,
    period_end: to,
    period_label: periodLabel,
    orders: b.orders,
    units: b.units,
    postage: b.postage.toFixed(2),
    packaging: b.packaging.toFixed(2),
    pick_fees: b.pickFees.toFixed(2),
  }))
  const exportColumns = [
    { key: "brand", label: "Brand" },
    { key: "period_start", label: "Period Start" },
    { key: "period_end", label: "Period End" },
    { key: "period_label", label: "Period Label" },
    { key: "orders", label: "Orders" },
    { key: "units", label: "Units" },
    { key: "postage", label: "Postage $" },
    { key: "packaging", label: "Packaging $" },
    { key: "pick_fees", label: "Pick Fees $" },
  ]

  return (
    <>
      <PageHeader
        title="Brand billing"
        description="What each brand owes for fulfillment in a period."
        action={
          <div className="flex gap-2">
            <CopyTableButton columns={exportColumns} rows={exportRows} />
            <ExportButton
              columns={exportColumns}
              rows={exportRows}
              filename={`brand-billing-${from}-to-${to}.csv`}
            />
          </div>
        }
      />

      <BillingFilters sites={sites ?? []} />

      {rows.length === 0 ? (
        <Placeholder icon={Receipt} title="Nothing billable in this period">
          Nothing shipped between {from} and {to}. Try a wider date range.
        </Placeholder>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-3 text-sm">
            <Stat label="Brands" value={rows.length.toLocaleString()} />
            <Stat label="Orders" value={t.orders.toLocaleString()} />
            <Stat label="Packaging" value={formatCurrency(t.packaging)} />
            <Stat label="Pick fees" value={formatCurrency(t.pickFees)} />
            <Stat label="Service total" value={formatCurrency(serviceTotal)} emphasis />
            <Stat label="Postage" value={formatCurrency(t.postage)} />
          </div>

          {truncated ||
          missingPickFee.length > 0 ||
          storeGaps.length > 0 ||
          manualGaps.length > 0 ||
          mixedChannel.length > 0 ? (
            <Card className="border-amber-500/50 bg-amber-50/50 dark:bg-amber-950/20">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-amber-700 dark:text-amber-400">
                  <TriangleAlert className="size-4" />
                  Check before you invoice
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-1.5 text-sm">
                {truncated ? (
                  <div>
                    This period is too large to read in one go, so the figures below are
                    incomplete. Bill one month at a time.
                  </div>
                ) : null}
                {missingPickFee.length > 0 ? (
                  <div>
                    <span className="font-semibold tabular-nums">{missingPickFee.length}</span>{" "}
                    shipped {missingPickFee.length === 1 ? "order has" : "orders have"} no pick fee
                    recorded, so the pick fee total is short by whatever{" "}
                    {missingPickFee.length === 1 ? "it" : "they"} should have been charged.{" "}
                    <span className="text-muted-foreground">
                      {missingPickFee
                        .slice(0, 8)
                        .map((o) => o.order_number)
                        .join(", ")}
                      {missingPickFee.length > 8 ? ` +${missingPickFee.length - 8} more` : ""}
                    </span>
                    <div className="mt-2">
                      <BackfillPickFeesButton orderIds={missingPickFee.map((o) => o.id)} />
                    </div>
                  </div>
                ) : null}
                {storeGaps.length > 0 ? (
                  <div>
                    <span className="font-semibold tabular-nums">{storeGaps.length}</span>{" "}
                    fulfilled store {storeGaps.length === 1 ? "group has" : "groups have"} no
                    packaging recorded. Clear them on the{" "}
                    <Link href="/reports/packaging-gaps" className="font-medium underline">
                      Packaging gaps
                    </Link>{" "}
                    report, then come back and export.
                  </div>
                ) : null}
                {manualGaps.length > 0 ? (
                  <div>
                    <span className="font-semibold tabular-nums">{manualGaps.length}</span>{" "}
                    fulfilled manual-channel {manualGaps.length === 1 ? "group has" : "groups have"}{" "}
                    no packaging recorded.{" "}
                    <span className="text-muted-foreground">
                      These do not appear on the Packaging gaps report — it only covers Shopify and
                      WooCommerce orders. Record packaging on the packing screen for the affected
                      group.
                    </span>
                  </div>
                ) : null}
                {mixedChannel.length > 0 ? (
                  <div>
                    <span className="font-semibold tabular-nums">{mixedChannel.length}</span>{" "}
                    {mixedChannel.length === 1 ? "group mixes" : "groups mix"} channels, so brand
                    attribution on {mixedChannel.length === 1 ? "it" : "them"} is a guess.
                  </div>
                ) : null}
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>Owed by brand — {periodLabel}</CardTitle>
            </CardHeader>
            <CardContent className="px-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Brand</TableHead>
                    <TableHead>Storefront</TableHead>
                    <TableHead className="text-right">Orders</TableHead>
                    <TableHead className="text-right">Units</TableHead>
                    <TableHead className="text-right">Packaging</TableHead>
                    <TableHead className="text-right">Pick fees</TableHead>
                    <TableHead className="text-right">Service total</TableHead>
                    <TableHead className="text-right">Postage</TableHead>
                    <TableHead className="text-right">Total w/ postage</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((b) => (
                    <TableRow key={b.siteId}>
                      <TableCell className="font-medium">{b.name}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {b.storefront ?? b.channel}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{b.orders}</TableCell>
                      <TableCell className="text-right tabular-nums">{b.units}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCurrency(b.packaging)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCurrency(b.pickFees)}
                      </TableCell>
                      <TableCell className="text-right font-semibold tabular-nums">
                        {formatCurrency(b.packaging + b.pickFees)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {formatCurrency(b.postage)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCurrency(b.packaging + b.pickFees + b.postage)}
                      </TableCell>
                    </TableRow>
                  ))}
                  <TableRow className="border-t-2 font-semibold">
                    <TableCell>Total</TableCell>
                    <TableCell />
                    <TableCell className="text-right tabular-nums">{t.orders}</TableCell>
                    <TableCell className="text-right tabular-nums">{t.units}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCurrency(t.packaging)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCurrency(t.pickFees)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCurrency(serviceTotal)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {formatCurrency(t.postage)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCurrency(grandTotal)}
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <p className="text-xs text-muted-foreground">
            {openGroups.length > 0 ? (
              <>
                {openGroups.length} {openGroups.length === 1 ? "order is" : "orders are"} still
                open in this window and {openGroups.length === 1 ? "is" : "are"} not included —
                nothing is billed until it ships. They appear in the period they ship in.{" "}
              </>
            ) : null}
            Service total is packaging plus pick fees. Postage is shown separately because it is
            a carrier cost passed through at what it actually cost. Product cost is not included
            — that belongs to the brand, not to us.
          </p>
        </div>
      )}
    </>
  )
}

function Stat({
  label,
  value,
  emphasis,
}: {
  label: string
  value: string
  emphasis?: boolean
}) {
  return (
    <div
      className={
        emphasis
          ? "rounded-lg border-2 border-foreground/20 bg-muted/50 px-4 py-2"
          : "rounded-lg border border-border px-4 py-2"
      }
    >
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
    </div>
  )
}
