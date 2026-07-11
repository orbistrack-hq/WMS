"use client"

import { useMemo, useState, useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { AlertCircle, CheckCircle2, Plus, X } from "lucide-react"

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
import { bulkRecordPackaging } from "./actions"

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

export type PackagingType = {
  id: string
  name: string
  kind: string
  unit_cost: number | string
}

const KIND_LABEL: Record<string, string> = {
  box: "Box",
  shipping_label: "Shipping label",
  jar: "Jar",
  jar_label: "Jar label",
  vacuum_bag: "Vacuum bag",
  custom: "Custom",
}

const num = (v: number | string | null | undefined) => Number(v ?? 0)

type Line = { packagingTypeId: string; quantity: number }

export function PackagingGapsTable({
  rows,
  packagingTypes,
}: {
  rows: GapRow[]
  packagingTypes: PackagingType[]
}) {
  const router = useRouter()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [lines, setLines] = useState<Line[]>([])
  const [pickType, setPickType] = useState<string>(packagingTypes[0]?.id ?? "")
  const [pickQty, setPickQty] = useState<number>(1)
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<
    | { kind: "ok"; groups: number; recorded: number; failed: number; firstError?: string }
    | { kind: "err"; error: string }
    | null
  >(null)

  const typeById = useMemo(() => {
    const m = new Map<string, PackagingType>()
    for (const t of packagingTypes) m.set(t.id, t)
    return m
  }, [packagingTypes])

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
  const selectedCount = selectedRows.length

  function addLine() {
    if (!pickType || !(pickQty > 0)) return
    setLines((prev) => {
      const existing = prev.find((l) => l.packagingTypeId === pickType)
      if (existing) {
        return prev.map((l) =>
          l.packagingTypeId === pickType
            ? { ...l, quantity: l.quantity + Math.trunc(pickQty) }
            : l,
        )
      }
      return [...prev, { packagingTypeId: pickType, quantity: Math.trunc(pickQty) }]
    })
  }

  function removeLine(id: string) {
    setLines((prev) => prev.filter((l) => l.packagingTypeId !== id))
  }

  /** Quick preset: 1 box + 1 shipping label (the default per-order packaging). */
  function addDefault() {
    const box = packagingTypes.find((t) => t.kind === "box")
    const label = packagingTypes.find((t) => t.kind === "shipping_label")
    const next: Line[] = []
    if (box) next.push({ packagingTypeId: box.id, quantity: 1 })
    if (label) next.push({ packagingTypeId: label.id, quantity: 1 })
    setLines(next)
  }

  const linesCost = lines.reduce(
    (sum, l) => sum + num(typeById.get(l.packagingTypeId)?.unit_cost) * l.quantity,
    0,
  )

  function apply() {
    setResult(null)
    startTransition(async () => {
      const res = await bulkRecordPackaging(selectedGroupIds, lines)
      if (!res.ok) {
        setResult({ kind: "err", error: res.error })
        return
      }
      setResult({
        kind: "ok",
        groups: res.groups,
        recorded: res.recorded,
        failed: res.failed,
        firstError: res.firstError,
      })
      setSelected(new Set())
      router.refresh()
    })
  }

  const canApply =
    selectedGroupIds.length > 0 && lines.length > 0 && !pending

  return (
    <div className="flex flex-col gap-3">
      {/* Bulk record bar */}
      <div className="flex flex-col gap-3 border-b border-border px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">
            {selectedCount > 0
              ? `${selectedCount} order${selectedCount === 1 ? "" : "s"} selected`
              : "Select orders to record packaging in bulk"}
          </span>
          {selectedGroupIds.length > 0 &&
          selectedGroupIds.length !== selectedCount ? (
            <Badge variant="muted">{selectedGroupIds.length} groups</Badge>
          ) : null}
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Packaging
            <select
              className="h-9 rounded-md border border-border bg-background px-2 text-sm text-foreground"
              value={pickType}
              onChange={(e) => setPickType(e.target.value)}
            >
              {packagingTypes.length === 0 ? (
                <option value="">No packaging types</option>
              ) : (
                packagingTypes.map((t) => (
                  <option key={t.id} value={t.id}>
                    {KIND_LABEL[t.kind] ?? t.kind}: {t.name} (
                    {formatCurrency(num(t.unit_cost))})
                  </option>
                ))
              )}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Qty
            <input
              type="number"
              min={1}
              className="h-9 w-20 rounded-md border border-border bg-background px-2 text-sm text-foreground"
              value={pickQty}
              onChange={(e) => setPickQty(Number(e.target.value))}
            />
          </label>
          <Button
            size="sm"
            variant="outline"
            onClick={addLine}
            disabled={!pickType || !(pickQty > 0)}
          >
            <Plus data-icon="inline-start" /> Add
          </Button>
          <Button size="sm" variant="ghost" onClick={addDefault}>
            Default: 1 box + 1 label
          </Button>
        </div>

        {lines.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {lines.map((l) => {
              const t = typeById.get(l.packagingTypeId)
              return (
                <Badge key={l.packagingTypeId} variant="outline" className="gap-1">
                  {l.quantity}× {t?.name ?? "?"}
                  <button
                    type="button"
                    onClick={() => removeLine(l.packagingTypeId)}
                    className="ml-0.5 opacity-60 hover:opacity-100"
                    aria-label="Remove packaging line"
                  >
                    <X className="size-3" />
                  </button>
                </Badge>
              )
            })}
            <span className="ml-1 text-xs text-muted-foreground">
              {formatCurrency(linesCost)} / group
            </span>
          </div>
        ) : null}

        <div className="flex items-center gap-2">
          <Button size="sm" onClick={apply} disabled={!canApply}>
            <CheckCircle2 data-icon="inline-start" />
            {pending
              ? "Recording…"
              : `Record on ${selectedGroupIds.length} group${
                  selectedGroupIds.length === 1 ? "" : "s"
                }`}
          </Button>
          {result ? (
            <span
              className={`flex items-center gap-1.5 text-sm ${
                result.kind === "err" || (result.kind === "ok" && result.failed > 0)
                  ? "text-destructive"
                  : "text-muted-foreground"
              }`}
            >
              {result.kind === "err" ? (
                <>
                  <AlertCircle className="size-4" /> {result.error}
                </>
              ) : (
                <>
                  <CheckCircle2 className="size-4" />
                  Recorded on {result.groups} group
                  {result.groups === 1 ? "" : "s"}
                  {result.failed > 0
                    ? ` — ${result.failed} line(s) failed${
                        result.firstError ? `: ${result.firstError}` : ""
                      }`
                    : ""}
                </>
              )}
            </span>
          ) : null}
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
