"use client"

import { useEffect, useRef, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { AlertCircle, Plus, Trash2, Wand2 } from "lucide-react"

import type { SuggestedPackagingLine } from "@/lib/packing/packaging-rules"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select } from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { formatCurrency } from "@/lib/format"
import { recordPackaging, removePackaging, updatePackagingQty } from "../actions"

export const KIND_LABEL: Record<string, string> = {
  box: "Box",
  shipping_label: "Label",
  jar: "Jar",
  jar_label: "Jar label",
  vacuum_bag: "Vacuum bag",
  mylar_bag: "Mylar bag",
  custom: "Custom",
}

export type UsageLine = {
  id: string
  type_name: string
  kind: string
  quantity: number
  unit_cost_snapshot: number
}

type PackagingType = {
  id: string
  name: string
  kind: string
  unit_cost: number
}

export function PackagingEditor({
  groupId,
  lines,
  packagingTypes,
  suggested = [],
  unknownWeightUnits = 0,
  autoApply = false,
}: {
  groupId: string
  lines: UsageLine[]
  packagingTypes: PackagingType[]
  /** Weight-config seed (FB-6), only when nothing is recorded yet. */
  suggested?: SuggestedPackagingLine[]
  /** Units the rule couldn't classify (no weight) — flagged for manual entry. */
  unknownWeightUnits?: number
  /** FB-6: record the suggested packaging automatically on load (no button). */
  autoApply?: boolean
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [addType, setAddType] = useState(packagingTypes[0]?.id ?? "")
  const [addQty, setAddQty] = useState("1")

  const total = lines.reduce(
    (s, l) => s + l.quantity * l.unit_cost_snapshot,
    0,
  )

  function run(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null)
    startTransition(async () => {
      const res = await fn()
      if (!res.ok) setError(res.error ?? "Something went wrong.")
      else router.refresh()
    })
  }

  function commitQty(line: UsageLine, raw: string) {
    const q = Number(raw)
    if (!Number.isFinite(q) || q === line.quantity) return
    if (q <= 0) {
      setError("Quantity must be positive.")
      return
    }
    run(() => updatePackagingQty(line.id, groupId, q))
  }

  function add() {
    const q = Number(addQty)
    if (!addType) {
      setError("Pick a packaging type.")
      return
    }
    if (!(q > 0)) {
      setError("Quantity must be positive.")
      return
    }
    run(() => recordPackaging(groupId, addType, q))
  }

  // Record every suggested line (weight rule), then refresh. Sequential so a
  // failed write surfaces its error and stops rather than half-applying blind.
  function applySuggested() {
    setError(null)
    startTransition(async () => {
      for (const s of suggested) {
        const res = await recordPackaging(groupId, s.typeId, s.qty)
        if (!res.ok) {
          setError(res.error ?? "Something went wrong.")
          return
        }
      }
      router.refresh()
    })
  }

  const showSuggested = lines.length === 0 && suggested.length > 0

  // FB-6: apply the computed packaging automatically once, on load, when nothing
  // is recorded yet — no button. The ref guards against re-firing; after it
  // records, the refresh reloads with lines so it won't run again.
  const autoFired = useRef(false)
  useEffect(() => {
    if (autoApply && !autoFired.current && showSuggested) {
      autoFired.current = true
      applySuggested()
    }
    // applySuggested is stable enough for this one-shot; the ref prevents re-runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoApply, showSuggested])

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        Recorded per fulfillment group: enter the box and label once; jars,
        jar labels, and bags sum across all orders in the group.
      </p>

      {error ? (
        <div className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      {showSuggested ? (
        <div className="flex flex-col gap-2 rounded-lg border border-dashed border-primary/40 bg-primary/5 p-3">
          <div className="flex items-center gap-1.5 text-sm font-medium">
            <Wand2 className="size-4 text-primary" />{" "}
            {autoApply
              ? isPending
                ? "Auto-filling packaging from weight…"
                : "Auto-filled from weight"
              : "Suggested from weight"}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {suggested.map((s) => (
              <span
                key={s.typeId}
                className="rounded bg-background px-2 py-0.5 text-sm tabular-nums"
              >
                {s.qty} × {s.typeName}
              </span>
            ))}
          </div>
          {unknownWeightUnits > 0 ? (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              {unknownWeightUnits} unit{unknownWeightUnits === 1 ? "" : "s"} have
              no weight set — add their packaging by hand.
            </p>
          ) : null}
          {autoApply ? (
            <p className="text-xs text-muted-foreground">
              Filled automatically — adjust any line below (e.g. the box) before
              confirming.
            </p>
          ) : (
            <div>
              <Button size="sm" onClick={applySuggested} disabled={isPending}>
                <Plus data-icon="inline-start" /> Apply suggested
              </Button>
            </div>
          )}
        </div>
      ) : null}

      {lines.length > 0 ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Item</TableHead>
              <TableHead>Type</TableHead>
              <TableHead className="text-right">Qty</TableHead>
              <TableHead className="text-right">Unit</TableHead>
              <TableHead className="text-right">Cost</TableHead>
              <TableHead className="w-px" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.map((l) => (
              <TableRow key={l.id}>
                <TableCell className="font-medium">{l.type_name}</TableCell>
                <TableCell>
                  <Badge variant="muted">
                    {KIND_LABEL[l.kind] ?? l.kind}
                  </Badge>
                </TableCell>
                <TableCell className="text-right">
                  <Input
                    type="number"
                    min="1"
                    step="1"
                    defaultValue={l.quantity}
                    disabled={isPending}
                    onBlur={(e) => commitQty(l, e.target.value)}
                    className="ml-auto w-16 text-right"
                  />
                </TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {formatCurrency(l.unit_cost_snapshot)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatCurrency(l.quantity * l.unit_cost_snapshot)}
                </TableCell>
                <TableCell>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Remove line"
                    disabled={isPending}
                    onClick={() => run(() => removePackaging(l.id, groupId))}
                  >
                    <Trash2 />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <p className="text-sm text-muted-foreground">
          No packaging recorded yet.
        </p>
      )}

      <div className="flex flex-wrap items-end gap-2 rounded-lg border border-border p-3">
        <div className="flex min-w-44 flex-1 flex-col gap-1">
          <Label className="text-xs">Packaging type</Label>
          <Select value={addType} onChange={(e) => setAddType(e.target.value)}>
            {packagingTypes.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({KIND_LABEL[t.kind] ?? t.kind}) —{" "}
                {formatCurrency(t.unit_cost)}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex w-20 flex-col gap-1">
          <Label className="text-xs">Qty</Label>
          <Input
            type="number"
            min="1"
            step="1"
            value={addQty}
            onChange={(e) => setAddQty(e.target.value)}
          />
        </div>
        <Button onClick={add} disabled={isPending || packagingTypes.length === 0}>
          <Plus data-icon="inline-start" /> Add
        </Button>
      </div>

      <div className="flex justify-between border-t pt-2 text-sm">
        <span className="text-muted-foreground">Packaging cost</span>
        <span className="font-semibold tabular-nums">
          {formatCurrency(total)}
        </span>
      </div>
    </div>
  )
}
