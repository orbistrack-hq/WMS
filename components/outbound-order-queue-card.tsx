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
import { Badge } from "@/components/ui/badge"
import { formatDateTime } from "@/lib/format"

type BadgeVariant = "success" | "warning" | "destructive" | "muted" | "secondary"

export type OutboundOrderQueueRow = {
  id: string
  status: string
  attempts: number
  last_error: string | null
  next_attempt_at: string
  updated_at: string
  order_number: string
  site_name: string
}

const STATUS_BADGE: Record<string, { label: string; variant: BadgeVariant }> = {
  pending: { label: "Waiting", variant: "secondary" },
  processing: { label: "Sending", variant: "warning" },
  failed: { label: "Failed", variant: "destructive" },
}

/** PostgREST columns to select for an order queue row (job + embedded order/site). */
export const OUTBOUND_ORDER_QUEUE_SELECT =
  "id, site_id, status, attempts, last_error, next_attempt_at, updated_at, order:orders(order_number), site:sites(name)"

type RawJob = {
  id: string
  site_id: string
  status: string
  attempts: number
  last_error: string | null
  next_attempt_at: string
  updated_at: string
  order: { order_number: string | null } | null
  site: { name: string | null } | null
}

/**
 * Shape raw queue rows for display, keeping only jobs whose site the caller cares
 * about (a site can have connections on more than one channel; each page passes
 * the site ids of its own connections).
 */
export function mapOutboundOrderJobs(
  data: unknown,
  allowedSiteIds: Set<string>,
): OutboundOrderQueueRow[] {
  return ((data ?? []) as RawJob[])
    .filter((j) => allowedSiteIds.has(j.site_id))
    .map((j) => ({
      id: j.id,
      status: j.status,
      attempts: j.attempts,
      last_error: j.last_error,
      next_attempt_at: j.next_attempt_at,
      updated_at: j.updated_at,
      order_number: j.order?.order_number ?? "—",
      site_name: j.site?.name ?? "—",
    }))
}

/**
 * Read-only drill-down of the outbound order queue: which orders are waiting to
 * have their fulfillment (with tracking) pushed to the store, plus anything that
 * has failed and why. Rows are already RLS-scoped to sites the viewer can access.
 */
export function OutboundOrderQueueCard({
  rows,
  showSite = true,
}: {
  rows: OutboundOrderQueueRow[]
  showSite?: boolean
}) {
  const failed = rows.filter((r) => r.status === "failed").length
  const waiting = rows.length - failed

  return (
    <Card className="p-0">
      <CardHeader className="p-(--card-spacing)">
        <CardTitle className="text-base">Outbound order queue</CardTitle>
        <CardDescription>
          Shipped orders waiting to push their fulfillment (with tracking) to the
          store, plus any that failed to send.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        {rows.length === 0 ? (
          <p className="px-4 pb-2 text-sm text-muted-foreground">
            Nothing queued — every shipped order has been pushed to the store.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap gap-1.5 px-4 pb-3">
              {waiting > 0 ? (
                <Badge variant="secondary">{waiting} waiting</Badge>
              ) : null}
              {failed > 0 ? (
                <Badge variant="destructive">{failed} failed</Badge>
              ) : null}
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Order</TableHead>
                  {showSite ? <TableHead>Store</TableHead> : null}
                  <TableHead>Status</TableHead>
                  <TableHead>Detail</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => {
                  const badge =
                    STATUS_BADGE[r.status] ?? {
                      label: r.status,
                      variant: "muted" as BadgeVariant,
                    }
                  return (
                    <TableRow key={r.id}>
                      <TableCell className="font-medium">
                        {r.order_number}
                      </TableCell>
                      {showSite ? (
                        <TableCell className="text-muted-foreground">
                          {r.site_name}
                        </TableCell>
                      ) : null}
                      <TableCell>
                        <Badge variant={badge.variant}>{badge.label}</Badge>
                      </TableCell>
                      <TableCell className="max-w-72 text-xs text-muted-foreground">
                        {r.status === "failed" ? (
                          <span className="flex flex-col">
                            <span className="truncate">
                              {r.last_error ?? "Push failed"}
                            </span>
                            <span>
                              {r.attempts} attempt{r.attempts === 1 ? "" : "s"} ·
                              next try {formatDateTime(r.next_attempt_at)}
                            </span>
                          </span>
                        ) : r.status === "processing" ? (
                          "Sending now…"
                        ) : (
                          `Queued ${formatDateTime(r.updated_at)}`
                        )}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </>
        )}
      </CardContent>
    </Card>
  )
}
