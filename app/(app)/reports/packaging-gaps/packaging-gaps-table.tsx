"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { PackageCheck } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { formatCurrency, formatDate } from "@/lib/format"
import { CHANNEL_LABEL, type OrderChannel } from "@/lib/orders/types"

export type GapRow = {
  order_id: string
  order_number: string
  site_name: string | null
  customer_name: string | null
  channel: string
  group_id: string
  group_order_count: number | string
  fulfilled_at: string | null
  unit_count: number | string
  order_value: number | string
  auto_fulfilled: boolean
}

const num = (v: number | string | null | undefined) => Number(v ?? 0)

/**
 * Packaging-gaps table with selection. Selecting orders and hitting "Mass pack"
 * opens the wave-style record screen, where each group's packaging is pre-seeded
 * from the weight rules and recorded per group (once per group, combine-safe).
 */
export function PackagingGapsTable({ rows }: { rows: GapRow[] }) {
  const router = useRouter()
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const allIds = rows.map((r) => r.order_id)
  const allSelected = allIds.length > 0 && allIds.every((id) => selected.has(id))

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(allIds))
  }

  const selectedRows = rows.filter((r) => selected.has(r.order_id))
  const selectedGroupIds = Array.from(
    new Set(selectedRows.map((r) => r.group_id)),
  )

  function massPack(groupIds: string[]) {
    if (groupIds.length === 0) return
    router.push(`/reports/packaging-gaps/pack?groups=${groupIds.join(",")}`)
  }

  const allGroupIds = Array.from(new Set(rows.map((r) => r.group_id)))

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <span className="text-sm font-medium">
          {selectedRows.length > 0
            ? `${selectedRows.length} selected`
            : "Select orders to mass-pack, or pack them all"}
        </span>
        {selectedGroupIds.length > 0 ? (
          <Badge variant="muted">
            {selectedGroupIds.length} group
            {selectedGroupIds.length === 1 ? "" : "s"}
          </Badge>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          <Button
            size="sm"
            onClick={() => massPack(selectedGroupIds)}
            disabled={selectedGroupIds.length === 0}
          >
            <PackageCheck data-icon="inline-start" /> Mass pack selected
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => massPack(allGroupIds)}
            disabled={allGroupIds.length === 0}
          >
            Mass pack all ({allGroupIds.length})
          </Button>
        </div>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-10">
              <input
                type="checkbox"
                className="size-4 cursor-pointer accent-primary"
                checked={allSelected}
                onChange={toggleAll}
                aria-label="Select all orders"
                title="Select all orders on this page"
              />
            </TableHead>
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
          {rows.map((r) => {
            const isSelected = selected.has(r.order_id)
            return (
              <TableRow
                key={r.order_id}
                data-state={isSelected ? "selected" : undefined}
              >
                <TableCell>
                  <input
                    type="checkbox"
                    className="size-4 cursor-pointer accent-primary"
                    checked={isSelected}
                    onChange={() => toggle(r.order_id)}
                    aria-label={`Select order ${r.order_number}`}
                  />
                </TableCell>
                <TableCell className="font-medium">
                  {r.order_number}
                  {num(r.group_order_count) > 1 ? (
                    <span className="ml-1 text-xs text-muted-foreground">
                      (combined ×{num(r.group_order_count)})
                    </span>
                  ) : null}
                  {r.auto_fulfilled ? (
                    <span
                      className="ml-1 text-xs text-muted-foreground"
                      title="Marked completed at the store (shipped outside OT) — not packed locally"
                    >
                      · completed at store
                    </span>
                  ) : null}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {r.fulfilled_at ? formatDate(r.fulfilled_at) : "—"}
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
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}
