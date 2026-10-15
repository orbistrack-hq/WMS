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
 * Everything comes from ONE call, brand_billing_summary (migration 0112), which
 * does the per-brand roll-up in the database. The page used to download every
 * cost row, charge, order and line item in the period (~20 requests) to sum
 * them here; each was a chance to time out. That migration built on 0030's cost
 * data, which said outright that the invoice / paid-unpaid layer was "a
 * deliberate later phase"; until that phase lands, the person doing billing
 * exports this grid and pastes it into the Fulfillment Payment Tracker
 * workbook, which holds invoice numbers and paid status. The CSV/copy column
 * order matches that workbook's Invoices sheet (columns B–I) so it is a clean
 * paste with no rearranging — do not reorder exportColumns without updating it.
 *
 * TWO COSTS, TWO GRAINS (rolled up separately inside the function):
 *   packaging            FULFILLMENT GROUP grain — fulfilled groups whose
 *                        billing_date is in the period
 *   pick fees            ORDER grain (billing_charges, snapshotted at
 *                        fulfilment with the fee schedule that was in force)
 *
 * POSTAGE IS DELIBERATELY ABSENT. ShipStation buys the labels and bills the
 * carrier charge directly, so it never reaches this ledger. A column reading
 * $0.00 on a billing screen invites someone to treat it as "no postage owed"
 * rather than "not ours to bill", so it is removed rather than shown empty.
 *
 * THE BILLING BASIS IS FULFILMENT, NOT SHIPMENT. OT does not track when a
 * parcel actually leaves — ShipStation does, and the shipments table here is
 * optional and largely unused. billing_date is coalesce(group.fulfilled_at,
 * group.created_at): the moment OT recorded the pick/pack work as done. That is
 * the right basis anyway, since what is being billed IS that work — a parcel
 * that sits in a carrier's queue for three days does not change what we did.
 * Say "fulfilled" in anything user-facing; "shipped" implies a carrier event
 * this system never sees.
 *
 * DATES ARE PACIFIC. The app is Pacific end-to-end (migration 0055); the
 * function pins its own timezone, so period days are Pacific days and an order
 * fulfilled after 5pm on the last of the month stays in that month's invoice.
 */

type SummaryRow = {
  site_id: string
  site_name: string
  channel: string
  storefront: string | null
  fulfilled_groups: number | string
  open_groups: number | string
  packaging: number | string
  store_gap_groups: number | string
  manual_gap_groups: number | string
  mixed_channel_groups: number | string
  orders: number | string
  units: number | string
  pick_fees: number | string
  missing_fee_order_ids: string[]
  missing_fee_order_numbers: string[]
  shake_grams: number | string
}

const num = (v: number | string | null | undefined) => Number(v ?? 0)

/** Attempts before the page gives up and shows the "did not fully load" card. */
const SUMMARY_ATTEMPTS = 3

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

  // A transient failure (a timeout, a dropped connection) is retried quietly
  // with a short backoff. Only if every attempt fails does the page show an
  // error — and it shows the error rather than any numbers, because a partial
  // or empty total looks exactly like a quieter month and gets invoiced.
  const loadSummary = async () => {
    let last: unknown = null
    for (let attempt = 1; attempt <= SUMMARY_ATTEMPTS; attempt++) {
      const { data, error } = await supabase.rpc("brand_billing_summary", {
        p_from: from,
        p_to: to,
        p_site: sp.site || null,
      })
      if (!error) return { data: (data ?? []) as SummaryRow[], error: null }
      last = error
      if (attempt < SUMMARY_ATTEMPTS) await new Promise((r) => setTimeout(r, 400 * attempt))
    }
    return { data: [] as SummaryRow[], error: last }
  }

  const [{ data: sites }, summary] = await Promise.all([
    supabase.from("sites").select("id, name").order("name"),
    loadSummary(),
  ])
  const loadFailed = summary.error !== null

  // Only brands with something billable (or shake to report) get a row. Open
  // groups and missing pick fees are disclosed below regardless — a brand
  // asking "why is this month low" deserves the number.
  const rows = summary.data
    .filter((r) => num(r.fulfilled_groups) > 0 || num(r.orders) > 0 || num(r.shake_grams) > 0)
    .map((r) => ({
      siteId: r.site_id,
      name: r.site_name,
      channel: r.channel,
      storefront: r.storefront,
      orders: num(r.orders),
      units: num(r.units),
      packaging: num(r.packaging),
      pickFees: num(r.pick_fees),
      shakeGrams: num(r.shake_grams),
    }))

  const t = rows.reduce(
    (acc, b) => {
      acc.orders += b.orders
      acc.units += b.units
      acc.packaging += b.packaging
      acc.pickFees += b.pickFees
      acc.shakeGrams += b.shakeGrams
      return acc
    },
    { orders: 0, units: 0, packaging: 0, pickFees: 0, shakeGrams: 0 },
  )
  const totalBillable = t.packaging + t.pickFees

  // --- Under-billing checks -------------------------------------------------
  // Both are money we earned and would otherwise invoice short.
  const missingPickFee = summary.data.flatMap((r) =>
    r.missing_fee_order_ids.map((id, i) => ({
      id,
      order_number: r.missing_fee_order_numbers[i],
    })),
  )
  // Only FULFILLED groups can have a packaging gap. Split by channel because the
  // two halves are cleared in different places: the Packaging gaps report covers
  // store-channel orders only (migration 0062 scopes it to shopify/woocommerce),
  // so a manual-channel gap will never show up there and has to be cleared on
  // the packing screen. Sending someone to an empty report is how they conclude
  // the warning is broken and start ignoring it.
  const sumOf = (k: keyof SummaryRow) => summary.data.reduce((a, r) => a + num(r[k] as number), 0)
  const storeGaps = sumOf("store_gap_groups")
  const manualGaps = sumOf("manual_gap_groups")
  const mixedChannel = sumOf("mixed_channel_groups")
  const openGroups = sumOf("open_groups")

  const periodLabel = from.slice(0, 7) === to.slice(0, 7) ? from.slice(0, 7) : `${from} to ${to}`

  // CSV column order mirrors the tracker's Invoices sheet, columns B–J.
  const exportRows = rows.map((b) => ({
    brand: b.name,
    period_start: from,
    period_end: to,
    period_label: periodLabel,
    orders: b.orders,
    units: b.units,
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
    { key: "packaging", label: "Packaging $" },
    { key: "pick_fees", label: "Pick Fees $" },
  ]

  return (
    <>
      <PageHeader
        title="Brand billing"
        description="What each brand owes for fulfillment in a period."
        action={
          loadFailed ? undefined : (
            <div className="flex gap-2">
              <CopyTableButton columns={exportColumns} rows={exportRows} />
              <ExportButton
                columns={exportColumns}
                rows={exportRows}
                filename={`brand-billing-${from}-to-${to}.csv`}
              />
            </div>
          )
        }
      />

      <BillingFilters sites={sites ?? []} />

      {loadFailed ? (
        <Card className="border-destructive/50 bg-destructive/5">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-destructive">
              <TriangleAlert className="size-4" />
              Billing data could not be loaded
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            The database did not answer after several tries, so no totals are shown rather
            than possibly wrong ones. Reload the page in a minute.
          </CardContent>
        </Card>
      ) : rows.length === 0 ? (
        <Placeholder icon={Receipt} title="Nothing billable in this period">
          Nothing was fulfilled between {from} and {to}. Try a wider date range.
        </Placeholder>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-3 text-sm">
            <Stat label="Brands" value={rows.length.toLocaleString()} />
            <Stat label="Orders" value={t.orders.toLocaleString()} />
            <Stat label="Packaging" value={formatCurrency(t.packaging)} />
            <Stat label="Pick fees" value={formatCurrency(t.pickFees)} />
            <Stat label="Total billable" value={formatCurrency(totalBillable)} emphasis />
          </div>

          {missingPickFee.length > 0 ||
          storeGaps > 0 ||
          manualGaps > 0 ||
          mixedChannel > 0 ? (
            <Card className="border-amber-500/50 bg-amber-50/50 dark:bg-amber-950/20">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-amber-700 dark:text-amber-400">
                  <TriangleAlert className="size-4" />
                  Check before you invoice
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-1.5 text-sm">
                {missingPickFee.length > 0 ? (
                  <div>
                    <span className="font-semibold tabular-nums">{missingPickFee.length}</span>{" "}
                    fulfilled {missingPickFee.length === 1 ? "order has" : "orders have"} no pick fee
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
                {storeGaps > 0 ? (
                  <div>
                    <span className="font-semibold tabular-nums">{storeGaps}</span>{" "}
                    fulfilled store {storeGaps === 1 ? "group has" : "groups have"} no
                    packaging recorded. Clear them on the{" "}
                    <Link href="/reports/packaging-gaps" className="font-medium underline">
                      Packaging gaps
                    </Link>{" "}
                    report, then come back and export.
                  </div>
                ) : null}
                {manualGaps > 0 ? (
                  <div>
                    <span className="font-semibold tabular-nums">{manualGaps}</span>{" "}
                    fulfilled manual-channel {manualGaps === 1 ? "group has" : "groups have"}{" "}
                    no packaging recorded.{" "}
                    <span className="text-muted-foreground">
                      These do not appear on the Packaging gaps report — it only covers Shopify and
                      WooCommerce orders. Record packaging on the packing screen for the affected
                      group.
                    </span>
                  </div>
                ) : null}
                {mixedChannel > 0 ? (
                  <div>
                    <span className="font-semibold tabular-nums">{mixedChannel}</span>{" "}
                    {mixedChannel === 1 ? "group mixes" : "groups mix"} channels, so brand
                    attribution on {mixedChannel === 1 ? "it" : "them"} is a guess.
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
                    <TableHead className="text-right">Total billable</TableHead>
                    <TableHead className="text-right">Shake</TableHead>
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
                        {formatGrams(b.shakeGrams)}
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
                      {formatCurrency(totalBillable)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatGrams(t.shakeGrams)}
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <p className="text-xs text-muted-foreground">
            {openGroups > 0 ? (
              <>
                {openGroups} {openGroups === 1 ? "order is" : "orders are"} still
                open in this window and {openGroups === 1 ? "is" : "are"} not included —
                nothing is billed until it is fulfilled. They appear in the period they are
                fulfilled in.{" "}
              </>
            ) : null}
            Shake is flower lost while packing for that brand in the period, recorded on the
            allocate screen; it is not billed and not in the export. Total billable is
            packaging plus pick fees. Postage is not included — ShipStation
            handles carrier charges directly. Product cost is not included either; that belongs
            to the brand, not to us.
          </p>
        </div>
      )}
    </>
  )
}

function formatGrams(g: number): string {
  const v = Math.round(g * 100) / 100
  return `${v.toLocaleString(undefined, { maximumFractionDigits: 2 })} g`
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
