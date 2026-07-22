"use client"

import { useMemo, useState, useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { AlertCircle, Check } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { childDisplayName } from "@/lib/catalog/weight"
import { setChildLowStockThreshold, setLowStockDefault } from "./actions"

export type LowStockRow = {
  child_sku_id: string
  product_name: string | null
  variant_label: string | null
  grams_per_unit: number | string | null
  sku: string | null
  site_name: string | null
  on_hand: number
  available: number
  reserved: number
  low_stock_threshold: number | null
  effective_low_stock_threshold: number
}

/**
 * Bulk low-stock manager. Lists every child SKU currently flagged low, lets the
 * ops team select rows and set/clear/silence their threshold in one action, and
 * edits the app-wide default. Silencing (threshold 0) is the clean-up path for
 * the many dead zero-stock SKUs.
 */
export function LowStockManager({
  rows,
  defaultThreshold,
  canManage,
}: {
  rows: LowStockRow[]
  defaultThreshold: number
  canManage: boolean
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkValue, setBulkValue] = useState("")
  const [defaultDraft, setDefaultDraft] = useState(String(defaultThreshold))

  const allIds = useMemo(() => rows.map((r) => r.child_sku_id), [rows])
  const allSelected = selected.size > 0 && selected.size === rows.length

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleAll() {
    setSelected((prev) =>
      prev.size === rows.length ? new Set() : new Set(allIds),
    )
  }

  function applyThreshold(point: number | null) {
    if (selected.size === 0) return
    setError(null)
    startTransition(async () => {
      const res = await setChildLowStockThreshold([...selected], point)
      if (!res.ok) setError(res.error)
      else {
        setSelected(new Set())
        setBulkValue("")
        router.refresh()
      }
    })
  }

  function applyBulkValue() {
    const raw = bulkValue.trim()
    if (raw === "") {
      setError("Enter a number, or use Clear / Silence.")
      return
    }
    applyThreshold(Number(raw))
  }

  function saveDefault() {
    setError(null)
    const raw = defaultDraft.trim()
    if (raw === "") {
      setError("Default can't be blank.")
      return
    }
    startTransition(async () => {
      const res = await setLowStockDefault(Number(raw))
      if (!res.ok) setError(res.error)
      else router.refresh()
    })
  }

  return (
    <div className="flex flex-col gap-3">
      {error ? (
        <div className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      {/* App-wide default */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm">
        <span className="font-medium">Default alert threshold</span>
        <span className="text-muted-foreground">
          applies to SKUs without their own override
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <Label
            htmlFor="low-stock-default"
            className="text-xs text-muted-foreground"
          >
            Alert at
          </Label>
          <Input
            id="low-stock-default"
            type="number"
            min="0"
            step="1"
            value={defaultDraft}
            onChange={(e) => setDefaultDraft(e.target.value)}
            className="w-24"
            disabled={!canManage || isPending}
          />
          {canManage ? (
            <Button
              size="icon-sm"
              variant="secondary"
              aria-label="Save default low-stock threshold"
              disabled={isPending}
              onClick={saveDefault}
            >
              <Check />
            </Button>
          ) : null}
        </div>
      </div>

      {/* Bulk action bar */}
      {canManage && selected.size > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
          <span className="font-medium">{selected.size} selected</span>
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            <Label
              htmlFor="bulk-threshold"
              className="text-xs text-muted-foreground"
            >
              Set alert at
            </Label>
            <Input
              id="bulk-threshold"
              type="number"
              min="0"
              step="1"
              value={bulkValue}
              onChange={(e) => setBulkValue(e.target.value)}
              placeholder="e.g. 10"
              className="w-24"
              disabled={isPending}
            />
            <Button
              size="sm"
              variant="secondary"
              disabled={isPending}
              onClick={applyBulkValue}
            >
              Apply
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={isPending}
              onClick={() => applyThreshold(null)}
              title="Clear the override — fall back to the default"
            >
              Use default
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={isPending}
              onClick={() => applyThreshold(0)}
              title="Silence — never flag these SKUs as low"
            >
              Silence
            </Button>
          </div>
        </div>
      ) : null}

      {rows.length === 0 ? (
        <p className="rounded-lg border border-border px-3 py-8 text-center text-sm text-muted-foreground">
          Nothing is low right now.
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                {canManage ? (
                  <TableHead className="w-10">
                    <input
                      type="checkbox"
                      className="size-4 accent-primary"
                      checked={allSelected}
                      aria-label="Select all"
                      onChange={toggleAll}
                    />
                  </TableHead>
                ) : null}
                <TableHead>Product</TableHead>
                <TableHead>SKU</TableHead>
                <TableHead>Site</TableHead>
                <TableHead className="text-right">On hand</TableHead>
                <TableHead className="text-right">Available</TableHead>
                <TableHead className="text-right">Alert at</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => {
                const checked = selected.has(r.child_sku_id)
                return (
                  <TableRow
                    key={r.child_sku_id}
                    data-state={checked ? "selected" : undefined}
                  >
                    {canManage ? (
                      <TableCell>
                        <input
                          type="checkbox"
                          className="size-4 accent-primary"
                          checked={checked}
                          aria-label={`Select ${r.product_name ?? "SKU"}`}
                          onChange={() => toggle(r.child_sku_id)}
                        />
                      </TableCell>
                    ) : null}
                    <TableCell className="font-medium">
                      <Link
                        href={`/inventory/${r.child_sku_id}`}
                        className="hover:underline"
                      >
                        {childDisplayName(
                          r.product_name,
                          r.variant_label,
                          r.grams_per_unit,
                        )}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {r.sku ?? "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {r.site_name ?? "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      <Badge variant={r.on_hand <= 0 ? "destructive" : "warning"}>
                        {r.on_hand}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.available}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {r.effective_low_stock_threshold}
                      {r.low_stock_threshold === null ? (
                        <span className="ml-1 text-xs opacity-60">
                          (default)
                        </span>
                      ) : null}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        SKUs at or below their alert threshold (on-hand) show a low-stock banner
        at the top of the portal. Set a threshold of 0 to silence a SKU — useful
        for discontinued lines sitting at zero.
      </p>
    </div>
  )
}
