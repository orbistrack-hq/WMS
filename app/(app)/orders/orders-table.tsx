"use client"

import { useMemo, useState, useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { CheckCheck, Loader2, PauseCircle, PlayCircle } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { formatCurrency, formatDate } from "@/lib/format"
import {
  STATUS_BADGE,
  CHANNEL_LABEL,
  isActive,
  type OrderStatus,
  type OrderChannel,
} from "@/lib/orders/types"
import {
  bulkFulfill,
  bulkSetHold,
  bulkSetStatus,
  type BulkResult,
} from "./actions"

export type OrderTableRow = {
  id: string
  order_number: string
  status: OrderStatus
  on_hold: boolean
  backordered: boolean
  order_type: "standard" | "layaway"
  channel: OrderChannel
  sale_date: string
  customerName: string | null
  siteName: string | null
  itemCount: number
  total: number
}

type Summary = { verb: string; succeeded: number; failed: { number: string; error: string }[] }

/**
 * Orders list with bulk selection. The team fulfils and moves many orders at
 * once, so every row is checkable and a sticky action bar runs the matching
 * bulk server action across the selection. Terminal actions (fulfil) skip +
 * report per order; the summary names any order that couldn't be moved.
 */
export function OrdersTable({ rows }: { rows: OrderTableRow[] }) {
  const router = useRouter()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [pending, startTransition] = useTransition()
  const [summary, setSummary] = useState<Summary | null>(null)

  const byId = useMemo(() => {
    const m = new Map<string, OrderTableRow>()
    for (const r of rows) m.set(r.id, r)
    return m
  }, [rows])

  // Only orders that can still take a label/terminal move are selectable.
  const selectableIds = useMemo(
    () => rows.filter((r) => isActive(r.status)).map((r) => r.id),
    [rows],
  )
  const allSelected =
    selectableIds.length > 0 && selectableIds.every((id) => selected.has(id))

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(selectableIds))
  }

  const selectedIds = [...selected]
  const selectedCount = selectedIds.length

  function run(verb: string, fn: () => Promise<BulkResult>) {
    setSummary(null)
    startTransition(async () => {
      const res = await fn()
      if (!res.ok) {
        setSummary({ verb, succeeded: 0, failed: [{ number: "—", error: res.error }] })
        return
      }
      setSummary({
        verb,
        succeeded: res.succeeded.length,
        failed: res.failed.map((f) => ({
          number: byId.get(f.orderId)?.order_number ?? f.orderId.slice(0, 8),
          error: f.error,
        })),
      })
      setSelected(new Set())
      router.refresh()
    })
  }

  return (
    <div className="flex flex-col gap-3">
      <Card className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <input
                  type="checkbox"
                  className="size-4 cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-40"
                  checked={allSelected}
                  disabled={selectableIds.length === 0}
                  onChange={toggleAll}
                  aria-label="Select all active orders"
                  title="Select all active orders on this page"
                />
              </TableHead>
              <TableHead>Order</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead>Site</TableHead>
              <TableHead>Channel</TableHead>
              <TableHead className="text-right">Items</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead>Sale date</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((o) => {
              const badge = STATUS_BADGE[o.status]
              const selectable = isActive(o.status)
              const isSelected = selected.has(o.id)
              return (
                <TableRow key={o.id} data-state={isSelected ? "selected" : undefined}>
                  <TableCell>
                    <input
                      type="checkbox"
                      className="size-4 cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-40"
                      checked={isSelected}
                      disabled={!selectable}
                      onChange={() => toggle(o.id)}
                      aria-label={`Select order ${o.order_number}`}
                      title={
                        selectable ? "Select order" : "This order is already closed"
                      }
                    />
                  </TableCell>
                  <TableCell className="font-medium">
                    <Link href={`/orders/${o.id}`} className="hover:underline">
                      {o.order_number}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1.5">
                      <Badge variant={badge.variant}>{badge.label}</Badge>
                      {o.on_hold ? <Badge variant="destructive">Hold</Badge> : null}
                      {o.order_type === "layaway" ? (
                        <Badge variant="outline">Layaway</Badge>
                      ) : null}
                      {o.backordered ? (
                        <Badge variant="warning">Backordered</Badge>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {o.customerName ?? "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {o.siteName ?? "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {CHANNEL_LABEL[o.channel]}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {o.itemCount}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCurrency(o.total)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDate(o.sale_date)}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </Card>

      {/* Result summary from the last bulk run. */}
      {summary ? (
        <div
          className={`rounded-lg border px-4 py-3 text-sm ${
            summary.failed.length
              ? "border-warning/40 bg-warning/10"
              : "border-success/40 bg-success/10"
          }`}
        >
          <p className="font-medium">
            {summary.succeeded} order{summary.succeeded === 1 ? "" : "s"}{" "}
            {summary.verb}
            {summary.failed.length
              ? ` · ${summary.failed.length} skipped`
              : ""}
          </p>
          {summary.failed.length ? (
            <ul className="mt-1 list-inside list-disc text-muted-foreground">
              {summary.failed.map((f, i) => (
                <li key={i}>
                  {f.number}: {f.error}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {/* Bulk action bar — appears once anything is selected. */}
      {selectedCount > 0 ? (
        <div className="sticky bottom-4 z-10 flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3 shadow-lg">
          <span className="text-sm text-muted-foreground">
            {selectedCount} order{selectedCount === 1 ? "" : "s"} selected
          </span>
          <div className="flex flex-wrap items-center gap-2">
            {pending ? (
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            ) : null}
            <Button
              size="sm"
              disabled={pending}
              onClick={() => run("fulfilled", () => bulkFulfill(selectedIds))}
            >
              <CheckCheck className="size-4" /> Mark fulfilled
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => run("moved to picking", () => bulkSetStatus(selectedIds, "picking"))}
            >
              Picking
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => run("moved to packed", () => bulkSetStatus(selectedIds, "packed"))}
            >
              Packed
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => run("put on hold", () => bulkSetHold(selectedIds, true))}
            >
              <PauseCircle className="size-4" /> Hold
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => run("taken off hold", () => bulkSetHold(selectedIds, false))}
            >
              <PlayCircle className="size-4" /> Unhold
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => setSelected(new Set())}
            >
              Clear
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
