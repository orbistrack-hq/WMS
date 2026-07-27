import Link from "next/link"
import { AlertTriangle } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardContent,
  CardDescription,
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
import { formatDate } from "@/lib/format"
import { CHANNEL_LABEL, orderBadge, type OrderChannel, type OrderStatus } from "@/lib/orders/types"

// One open order line's claim on this SKU. Mirrors the sku_commitments view
// (migration 0083); quantities are pre-split there so they reconcile against
// inventory_levels without any arithmetic here.
export type Commitment = {
  line_id: string
  ordered_child_sku_id: string
  ordered_sku: string | null
  ordered_product_name: string | null
  via_delegate: boolean
  order_id: string
  order_number: string
  site_name: string | null
  channel: string
  order_type: string
  status: string
  on_hold: boolean
  hold_reason: string | null
  entered_at: string
  sale_date: string
  customer_name: string | null
  ordered_qty: number
  reserved_qty: number
  layby_qty: number
  backordered_qty: number
  pending_qty: number
  commitment_kind:
    | "reserved"
    | "hold"
    | "layby"
    | "backorder"
    | "pending_payment"
    | "service"
}

const KIND_BADGE: Record<
  Commitment["commitment_kind"],
  { label: string; variant: "info" | "warning" | "muted" | "secondary" }
> = {
  reserved: { label: "Reserved", variant: "info" },
  hold: { label: "On hold", variant: "warning" },
  layby: { label: "Layby", variant: "warning" },
  backorder: { label: "Backordered", variant: "muted" },
  pending_payment: { label: "Unpaid", variant: "muted" },
  service: { label: "Service SKU", variant: "muted" },
}

export function CommitmentsCard({
  rows,
  reserved,
  layby,
  state,
  truncated,
}: {
  rows: Commitment[]
  reserved: number
  layby: number
  /** "not_migrated" = 0083 not applied; "error" = the query failed. */
  state: "ok" | "not_migrated" | "error"
  /** The row query hit its cap, so the totals below are a partial sum. */
  truncated: boolean
}) {
  const sum = rows.reduce(
    (a, r) => ({
      reserved: a.reserved + r.reserved_qty,
      layby: a.layby + r.layby_qty,
      backordered: a.backordered + r.backordered_qty,
      pending: a.pending + r.pending_qty,
    }),
    { reserved: 0, layby: 0, backordered: 0, pending: 0 },
  )

  // Reconciliation gap. A positive gap means inventory_levels holds stock that
  // no open order can account for — the stranded-reservation failure mode that
  // migration 0082 fixed at source. Surfacing it here turns a silent "available
  // is wrong" into a visible number, so it is worth the extra row. Suppressed
  // when the row list was truncated, since a partial sum ALWAYS looks short.
  const reservedGap = truncated ? 0 : reserved - sum.reserved
  const laybyGap = truncated ? 0 : layby - sum.layby

  return (
    <Card id="commitments">
      <CardHeader>
        <CardTitle>Committed stock</CardTitle>
        <CardDescription>
          Open orders with a claim on this SKU. Reserved and layby add up to the
          counters above; backordered and unpaid orders hold no stock.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        {state === "not_migrated" ? (
          <p className="px-4 text-sm text-muted-foreground">
            Not available yet — the database migration hasn&apos;t been applied.
            This turns on automatically once it lands.
          </p>
        ) : state === "error" ? (
          <p className="px-4 text-sm text-destructive">
            Could not load the orders behind this stock. The counters above are
            still accurate.
          </p>
        ) : rows.length === 0 ? (
          <div className="flex flex-col gap-3 px-4">
            <p className="text-sm text-muted-foreground">
              No open orders claim this SKU.
            </p>
            {reservedGap !== 0 || laybyGap !== 0 ? (
              <GapNotice reserved={reservedGap} layby={laybyGap} />
            ) : null}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Order</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead>Entered</TableHead>
                    <TableHead className="text-right">Ordered</TableHead>
                    <TableHead className="text-right">Reserved</TableHead>
                    <TableHead className="text-right">Layby</TableHead>
                    <TableHead className="text-right">Backordered</TableHead>
                    <TableHead className="text-right">Unpaid</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => {
                    const kind = KIND_BADGE[r.commitment_kind]
                    const order = orderBadge(
                      r.status as OrderStatus,
                      r.hold_reason,
                    )
                    return (
                      <TableRow key={r.line_id}>
                        <TableCell className="whitespace-nowrap font-medium">
                          <Link
                            href={`/orders/${r.order_id}`}
                            className="hover:underline"
                          >
                            {r.order_number}
                          </Link>
                          <div className="text-xs font-normal text-muted-foreground">
                            {CHANNEL_LABEL[r.channel as OrderChannel] ??
                              r.channel}
                            {r.site_name ? ` · ${r.site_name}` : ""}
                          </div>
                          {r.via_delegate ? (
                            <div
                              className="text-xs font-normal text-muted-foreground"
                              title="This order line is on a BOGO/free SKU that shares stock with this one."
                            >
                              via {r.ordered_sku ?? r.ordered_product_name}
                            </div>
                          ) : null}
                        </TableCell>
                        <TableCell className="whitespace-nowrap">
                          <div className="flex flex-wrap items-center gap-1">
                            <Badge variant={kind.variant}>{kind.label}</Badge>
                            {order.label !== kind.label ? (
                              <Badge variant="outline">{order.label}</Badge>
                            ) : null}
                            {r.on_hold ? (
                              <Badge variant="warning">Paused</Badge>
                            ) : null}
                          </div>
                        </TableCell>
                        <TableCell className="max-w-40 truncate text-muted-foreground">
                          {r.customer_name ?? "—"}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-muted-foreground">
                          {formatDate(r.entered_at)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {r.ordered_qty}
                        </TableCell>
                        <Qty value={r.reserved_qty} />
                        <Qty value={r.layby_qty} />
                        <Qty value={r.backordered_qty} />
                        <Qty value={r.pending_qty} />
                      </TableRow>
                    )
                  })}
                </TableBody>
                <tfoot className="border-t bg-muted/40">
                  <TableRow className="hover:bg-transparent">
                    <TableCell className="font-medium" colSpan={5}>
                      {truncated ? "First " : ""}
                      {rows.length} open line{rows.length === 1 ? "" : "s"}
                      {truncated ? " (partial totals)" : ""}
                    </TableCell>
                    <TableCell className="text-right font-medium tabular-nums">
                      {sum.reserved}
                    </TableCell>
                    <TableCell className="text-right font-medium tabular-nums">
                      {sum.layby}
                    </TableCell>
                    <TableCell className="text-right font-medium tabular-nums">
                      {sum.backordered}
                    </TableCell>
                    <TableCell className="text-right font-medium tabular-nums">
                      {sum.pending}
                    </TableCell>
                  </TableRow>
                </tfoot>
              </Table>
            </div>
            {reservedGap !== 0 || laybyGap !== 0 ? (
              <div className="px-4 pb-1">
                <GapNotice reserved={reservedGap} layby={laybyGap} />
              </div>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function Qty({ value }: { value: number }) {
  return (
    <TableCell className="text-right tabular-nums">
      {value > 0 ? value : <span className="text-muted-foreground">—</span>}
    </TableCell>
  )
}

/**
 * Shown only when the stock counters disagree with the open orders. A positive
 * gap is stranded stock (held by nothing); a negative gap means the view found
 * more claims than the counter records, which should be impossible and points
 * at a counter that was written outside the state machine.
 */
function GapNotice({ reserved, layby }: { reserved: number; layby: number }) {
  const parts: string[] = []
  if (reserved !== 0)
    parts.push(
      `${Math.abs(reserved)} reserved ${reserved > 0 ? "unaccounted for" : "over-counted"}`,
    )
  if (layby !== 0)
    parts.push(
      `${Math.abs(layby)} layby ${layby > 0 ? "unaccounted for" : "over-counted"}`,
    )

  return (
    <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
      <span>
        <span className="font-medium">Doesn&apos;t reconcile: </span>
        {parts.join(", ")}. The stock counter doesn&apos;t match the open
        orders — usually stock stranded by a deleted order. Run{" "}
        <code className="text-xs">scripts/recompute-reservations.sql</code> or
        ask an admin to recount this SKU.
      </span>
    </div>
  )
}
