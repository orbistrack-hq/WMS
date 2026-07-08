"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { AlertCircle, Plus, Trash2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select } from "@/components/ui/select"
import { formatCurrency } from "@/lib/format"
import {
  addOrderDefault,
  addWeightRule,
  deleteOrderDefault,
  deleteWeightRule,
  updateOrderDefaultQty,
  updateWeightRuleQty,
} from "./actions"

export type PkgType = { id: string; name: string; kind: string; unit_cost: number }
export type WeightRuleRow = {
  id: string
  grams_per_unit: number
  qty_per_unit: number
  type: PkgType | null
}
export type OrderDefaultRow = { id: string; qty: number; type: PkgType | null }

const fmtGrams = (g: number) => `${Number(g)}g`

/**
 * Edits the weight→packaging map + per-order defaults (FB-6). The packing screen
 * auto-fills from these: each unit maps to its exact-weight packaging, and every
 * order also gets the per-order defaults once. Ops-managed; read-only otherwise.
 */
export function PackagingRulesMapEditor({
  weightRules,
  orderDefaults,
  packagingTypes,
  canManage,
}: {
  weightRules: WeightRuleRow[]
  orderDefaults: OrderDefaultRow[]
  packagingTypes: PkgType[]
  canManage: boolean
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const [wGrams, setWGrams] = useState("")
  const [wType, setWType] = useState(packagingTypes[0]?.id ?? "")
  const [wQty, setWQty] = useState("1")

  const [dType, setDType] = useState(packagingTypes[0]?.id ?? "")
  const [dQty, setDQty] = useState("1")

  function run(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null)
    startTransition(async () => {
      const res = await fn()
      if (!res.ok) setError(res.error ?? "Something went wrong.")
      else router.refresh()
    })
  }

  const sortedRules = [...weightRules].sort(
    (a, b) =>
      a.grams_per_unit - b.grams_per_unit ||
      (a.type?.name ?? "").localeCompare(b.type?.name ?? ""),
  )

  return (
    <div className="flex flex-col gap-5">
      {error ? (
        <div className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      {/* Weight → packaging map */}
      <div className="flex flex-col gap-2">
        <p className="text-sm font-medium">Per unit, by weight</p>
        <p className="text-xs text-muted-foreground">
          Each unit of a given weight gets this packaging (e.g. 3.5g → jar, 7g →
          small Mylar). Match is on the exact per-unit weight.
        </p>
        {sortedRules.length === 0 ? (
          <p className="text-sm text-muted-foreground">No weight rules yet.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
            {sortedRules.map((r) => (
              <li
                key={r.id}
                className="flex items-center justify-between gap-2 px-3 py-2 text-sm"
              >
                <span className="w-14 font-medium tabular-nums">
                  {fmtGrams(r.grams_per_unit)}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {r.type?.name ?? "—"}
                  {r.type ? (
                    <span className="text-muted-foreground">
                      {" "}
                      · {formatCurrency(r.type.unit_cost)}
                    </span>
                  ) : null}
                </span>
                <span className="flex items-center gap-1 text-muted-foreground">
                  ×
                  <Input
                    type="number"
                    min="1"
                    step="1"
                    defaultValue={r.qty_per_unit}
                    disabled={!canManage || isPending}
                    onBlur={(e) => {
                      const q = Number(e.target.value)
                      if (q > 0 && q !== r.qty_per_unit)
                        run(() => updateWeightRuleQty(r.id, q))
                    }}
                    className="h-8 w-14 text-right"
                  />
                </span>
                {canManage ? (
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Remove rule"
                    disabled={isPending}
                    onClick={() => run(() => deleteWeightRule(r.id))}
                  >
                    <Trash2 />
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {canManage ? (
          <div className="flex flex-wrap items-end gap-2 rounded-lg border border-border p-3">
            <div className="flex w-24 flex-col gap-1">
              <Label className="text-xs">Weight (g)</Label>
              <Input
                type="number"
                min="0"
                step="0.01"
                value={wGrams}
                onChange={(e) => setWGrams(e.target.value)}
                placeholder="7"
              />
            </div>
            <div className="flex min-w-40 flex-1 flex-col gap-1">
              <Label className="text-xs">Packaging</Label>
              <Select value={wType} onChange={(e) => setWType(e.target.value)}>
                {packagingTypes.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex w-20 flex-col gap-1">
              <Label className="text-xs">Qty / unit</Label>
              <Input
                type="number"
                min="1"
                step="1"
                value={wQty}
                onChange={(e) => setWQty(e.target.value)}
              />
            </div>
            <Button
              disabled={isPending || !wGrams || !wType}
              onClick={() =>
                run(async () => {
                  const res = await addWeightRule(
                    Number(wGrams),
                    wType,
                    Number(wQty || 1),
                  )
                  if (res.ok) {
                    setWGrams("")
                    setWQty("1")
                  }
                  return res
                })
              }
            >
              <Plus data-icon="inline-start" /> Add rule
            </Button>
          </div>
        ) : null}
      </div>

      {/* Per-order defaults */}
      <div className="flex flex-col gap-2">
        <p className="text-sm font-medium">Every order gets</p>
        <p className="text-xs text-muted-foreground">
          Added once per order (counted once for combined orders) — e.g. box,
          label, vacuum sealed bag.
        </p>
        {orderDefaults.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No per-order defaults yet.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
            {orderDefaults.map((d) => (
              <li
                key={d.id}
                className="flex items-center justify-between gap-2 px-3 py-2 text-sm"
              >
                <span className="min-w-0 flex-1 truncate">
                  {d.type?.name ?? "—"}
                  {d.type ? (
                    <span className="text-muted-foreground">
                      {" "}
                      · {formatCurrency(d.type.unit_cost)}
                    </span>
                  ) : null}
                </span>
                <span className="flex items-center gap-1 text-muted-foreground">
                  ×
                  <Input
                    type="number"
                    min="1"
                    step="1"
                    defaultValue={d.qty}
                    disabled={!canManage || isPending}
                    onBlur={(e) => {
                      const q = Number(e.target.value)
                      if (q > 0 && q !== d.qty)
                        run(() => updateOrderDefaultQty(d.id, q))
                    }}
                    className="h-8 w-14 text-right"
                  />
                </span>
                {canManage ? (
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Remove default"
                    disabled={isPending}
                    onClick={() => run(() => deleteOrderDefault(d.id))}
                  >
                    <Trash2 />
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {canManage ? (
          <div className="flex flex-wrap items-end gap-2 rounded-lg border border-border p-3">
            <div className="flex min-w-40 flex-1 flex-col gap-1">
              <Label className="text-xs">Packaging</Label>
              <Select value={dType} onChange={(e) => setDType(e.target.value)}>
                {packagingTypes.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
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
                value={dQty}
                onChange={(e) => setDQty(e.target.value)}
              />
            </div>
            <Button
              disabled={isPending || !dType}
              onClick={() =>
                run(async () => {
                  const res = await addOrderDefault(dType, Number(dQty || 1))
                  if (res.ok) setDQty("1")
                  return res
                })
              }
            >
              <Plus data-icon="inline-start" /> Add
            </Button>
          </div>
        ) : null}
      </div>

      {!canManage ? (
        <p className="text-xs text-muted-foreground">
          You don&apos;t have permission to change these rules.
        </p>
      ) : null}
    </div>
  )
}
