import Link from "next/link"
import { notFound } from "next/navigation"
import { ArrowLeft } from "lucide-react"

import { createClient } from "@/lib/supabase/server"
import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { formatCurrency, formatDateTime } from "@/lib/format"
import { reasonLabel, reasonBadge, formatDelta } from "@/lib/inventory/types"
import { AdjustPanel } from "./adjust-panel"
import { TransferPanel, type TransferSibling } from "./transfer-panel"
import { ThresholdPanel } from "./threshold-panel"
import { CommitmentsCard, type Commitment } from "./commitments-card"

export const dynamic = "force-dynamic"

// Cap on the commitment rows fetched for one SKU. A single SKU with more than
// this many OPEN order lines means something is badly wrong upstream, but the
// card flags the totals as partial rather than quietly under-reporting.
const COMMITMENT_LIMIT = 500

type InvReport = {
  child_sku_id: string
  site_name: string | null
  product_name: string | null
  sku: string | null
  on_hand: number
  available: number
  reserved: number
  layby: number
  cost: number | string
  value_at_cost: number | string
  low_stock_threshold: number | null
  effective_low_stock_threshold: number
}

type LedgerRow = {
  id: string
  delta_on_hand: number
  delta_reserved: number
  delta_layby: number
  reason: string
  note: string | null
  created_at: string
}

export default async function InventoryItemPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const supabase = await createClient()

  const LEGACY_COLS = `child_sku_id, site_name, product_name, sku,
         on_hand, available, reserved, layby, cost, value_at_cost`
  const LOW_STOCK_COLS = `${LEGACY_COLS}, low_stock_threshold, effective_low_stock_threshold`

  // Open order lines claiming this SKU (migration 0083). Keyed on
  // stock_child_sku_id, so a BOGO twin's lines land on the SKU whose stock
  // actually moved and the totals reconcile against reserved/layby.
  const COMMITMENT_COLS = `line_id, ordered_child_sku_id, ordered_sku, ordered_product_name,
       via_delegate, order_id, order_number, site_name, channel, order_type, status,
       on_hold, hold_reason, entered_at, sale_date, customer_name, ordered_qty,
       reserved_qty, layby_qty, backordered_qty, pending_qty, commitment_kind`

  const [reportRes, ledgerRes, skuRes, commitmentsRes] = await Promise.all([
    supabase
      .from("inventory_report")
      .select(LOW_STOCK_COLS)
      .eq("child_sku_id", id)
      .maybeSingle(),
    supabase
      .from("inventory_ledger")
      .select(
        "id, delta_on_hand, delta_reserved, delta_layby, reason, note, created_at",
      )
      .eq("child_sku_id", id)
      .order("created_at", { ascending: false })
      .limit(100),
    supabase
      .from("child_skus")
      .select("product_id, is_active, store_variant_id")
      .eq("id", id)
      .maybeSingle(),
    supabase
      .from("sku_commitments")
      .select(COMMITMENT_COLS)
      .eq("stock_child_sku_id", id)
      .order("entered_at", { ascending: true })
      .limit(COMMITMENT_LIMIT),
  ])

  // 42703 = undefined_column: 0079 not applied yet. Re-query legacy columns so
  // the item page still works; the low-stock card stays dormant.
  let report = reportRes.data as Partial<InvReport> | null
  let lowStockReady = true
  if (reportRes.error?.code === "42703") {
    lowStockReady = false
    const legacy = await supabase
      .from("inventory_report")
      .select(LEGACY_COLS)
      .eq("child_sku_id", id)
      .maybeSingle()
    report = legacy.data as Partial<InvReport> | null
  }

  if (!report) notFound()
  const r = {
    ...report,
    low_stock_threshold: report.low_stock_threshold ?? null,
    effective_low_stock_threshold: report.effective_low_stock_threshold ?? 0,
  } as InvReport
  const { data: isOps } = lowStockReady
    ? await supabase.rpc("is_operator")
    : { data: false }
  const ledger = (ledgerRes.data ?? []) as unknown as LedgerRow[]

  // 0083 may not be applied yet: PostgREST reports an unknown relation as
  // PGRST205 (schema cache miss) and Postgres as 42P01. Either way the card
  // renders a dormant notice instead of failing the page — same posture as the
  // low-stock card. Any OTHER error is reported as a load failure rather than
  // silently showing an empty (and therefore falsely "unreconciled") table.
  const cErr = commitmentsRes.error
  const commitmentsState: "ok" | "not_migrated" | "error" = !cErr
    ? "ok"
    : cErr.code === "42P01" || cErr.code === "PGRST205"
      ? "not_migrated"
      : "error"
  const commitments = (commitmentsRes.data ?? []) as unknown as Commitment[]
  const sku = skuRes.data as
    | { product_id: string; is_active: boolean; store_variant_id: string | null }
    | null

  // Sibling child SKUs = the same product at OTHER sites, the valid transfer
  // destinations. Stock-tracked only; the RPC enforces the rest.
  let siblings: TransferSibling[] = []
  if (sku?.product_id) {
    const { data: sibRows } = await supabase
      .from("child_skus")
      .select("id, sku, cost, track_inventory, sites(name)")
      .eq("product_id", sku.product_id)
      .neq("id", id)
      .eq("is_active", true)
    siblings = ((sibRows ?? []) as unknown as Array<{
      id: string
      sku: string | null
      cost: number | string
      track_inventory: boolean | null
      sites: { name: string | null } | null
    }>)
      .filter((s) => s.track_inventory !== false)
      .map((s) => ({
        childId: s.id,
        siteName: s.sites?.name ?? null,
        sku: s.sku,
        cost: Number(s.cost),
      }))
  }

  return (
    <>
      <Link
        href="/inventory"
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> Inventory
      </Link>

      <div className="mb-6 flex flex-wrap items-center gap-2.5">
        <h1 className="text-2xl font-semibold tracking-tight">
          {r.product_name ?? "—"}
        </h1>
        {r.sku ? <Badge variant="outline">{r.sku}</Badge> : null}
        <span className="text-sm text-muted-foreground">{r.site_name}</span>
        {sku ? (
          <Link
            href={`/catalog/${sku.product_id}`}
            className="text-sm text-muted-foreground underline-offset-4 hover:underline"
          >
            View in catalog
          </Link>
        ) : null}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-4 lg:col-span-2">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="On hand" value={r.on_hand} />
            <Stat label="Available" value={r.available} emphasis />
            <Stat label="Reserved" value={r.reserved} tone="info" href="#commitments" />
            <Stat label="Layby" value={r.layby} tone="warning" href="#commitments" />
          </div>

          <CommitmentsCard
            rows={commitments}
            reserved={r.reserved}
            layby={r.layby}
            state={commitmentsState}
            truncated={commitments.length >= COMMITMENT_LIMIT}
          />

          <Card>
            <CardHeader>
              <CardTitle>Change log</CardTitle>
            </CardHeader>
            <CardContent className="px-0">
              {ledger.length === 0 ? (
                <p className="px-4 text-sm text-muted-foreground">
                  No movements recorded yet.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>When</TableHead>
                      <TableHead>Reason</TableHead>
                      <TableHead className="text-right">On hand</TableHead>
                      <TableHead className="text-right">Reserved</TableHead>
                      <TableHead className="text-right">Layby</TableHead>
                      <TableHead>Note</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {ledger.map((l) => (
                      <TableRow key={l.id}>
                        <TableCell className="whitespace-nowrap text-muted-foreground">
                          {formatDateTime(l.created_at)}
                        </TableCell>
                        <TableCell>
                          <Badge variant={reasonBadge(l.reason)}>
                            {reasonLabel(l.reason)}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatDelta(l.delta_on_hand)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatDelta(l.delta_reserved)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatDelta(l.delta_layby)}
                        </TableCell>
                        <TableCell className="max-w-48 truncate text-muted-foreground">
                          {l.note ?? "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Receive / adjust</CardTitle>
            </CardHeader>
            <CardContent>
              <AdjustPanel childSkuId={r.child_sku_id} onHand={r.on_hand} />
            </CardContent>
          </Card>

          {siblings.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>Transfer to another site</CardTitle>
              </CardHeader>
              <CardContent>
                <TransferPanel
                  sourceChildId={r.child_sku_id}
                  available={r.available}
                  siblings={siblings}
                />
              </CardContent>
            </Card>
          ) : null}

          {lowStockReady ? (
            <Card>
              <CardHeader>
                <CardTitle>Low-stock alert</CardTitle>
              </CardHeader>
              <CardContent>
                <ThresholdPanel
                  childSkuId={r.child_sku_id}
                  current={r.low_stock_threshold}
                  effective={r.effective_low_stock_threshold}
                  onHand={r.on_hand}
                  canManage={isOps === true}
                />
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>Valuation</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 text-sm">
              <Row label="Unit cost" value={formatCurrency(r.cost)} />
              <Row
                label="Value at cost"
                value={formatCurrency(r.value_at_cost)}
                emphasis
              />
              {sku ? (
                <>
                  <Row
                    label="Variant ID"
                    value={sku.store_variant_id ?? "—"}
                  />
                  <Row
                    label="SKU status"
                    value={sku.is_active ? "Active" : "Inactive"}
                  />
                </>
              ) : null}
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  )
}

function Stat({
  label,
  value,
  emphasis,
  tone,
  href,
}: {
  label: string
  value: number
  emphasis?: boolean
  tone?: "info" | "warning"
  /** When set, the tile jumps to the matching section (e.g. #commitments). */
  href?: string
}) {
  const body = (
    <CardContent className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span
        className={
          "text-xl font-semibold tabular-nums " +
          (tone === "info"
            ? "text-sky-600 dark:text-sky-400"
            : tone === "warning"
              ? "text-amber-600 dark:text-amber-400"
              : emphasis
                ? "text-foreground"
                : "text-foreground")
        }
      >
        {value}
      </span>
    </CardContent>
  )

  if (!href) return <Card>{body}</Card>
  return (
    <Card className="transition-colors hover:bg-muted/40">
      <a href={href} title={`See the orders behind ${label.toLowerCase()}`}>
        {body}
      </a>
    </Card>
  )
}

function Row({
  label,
  value,
  emphasis,
}: {
  label: string
  value: string
  emphasis?: boolean
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className={emphasis ? "font-semibold tabular-nums" : "tabular-nums"}>
        {value}
      </span>
    </div>
  )
}
