"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { AlertCircle, Plus, Trash2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select } from "@/components/ui/select"
import { formatCurrency } from "@/lib/format"
import { addSkuRuleByCode, deleteSkuRule, updateSkuRuleQty } from "./actions"
import type { PkgType } from "./packaging-rules-map-editor"

export type SkuRuleRow = {
  id: string
  qty_per_unit: number
  sku: string | null
  productName: string | null
  siteName: string | null
  type: PkgType | null
}

/**
 * Edits per-child-SKU packaging overrides (migration 0080). A SKU listed here
 * uses the mapped packaging INSTEAD of its weight-derived packaging — e.g. the
 * "free eighth" products ship in a 7g Mylar bag even though they weigh 3.5g.
 * Ops-managed; read-only otherwise. Adding is by SKU code and covers that code
 * across every site at once.
 */
export function PackagingSkuRulesEditor({
  rules,
  packagingTypes,
  canManage,
}: {
  rules: SkuRuleRow[]
  packagingTypes: PkgType[]
  canManage: boolean
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const [sku, setSku] = useState("")
  const [type, setType] = useState(packagingTypes[0]?.id ?? "")
  const [qty, setQty] = useState("1")

  function run(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null)
    startTransition(async () => {
      const res = await fn()
      if (!res.ok) setError(res.error ?? "Something went wrong.")
      else router.refresh()
    })
  }

  const sorted = [...rules].sort(
    (a, b) =>
      (a.productName ?? "").localeCompare(b.productName ?? "") ||
      (a.sku ?? "").localeCompare(b.sku ?? "") ||
      (a.siteName ?? "").localeCompare(b.siteName ?? ""),
  )

  return (
    <div className="flex flex-col gap-2">
      {error ? (
        <div className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      {sorted.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No SKU overrides yet. Every SKU uses its weight-based packaging.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
          {sorted.map((r) => (
            <li
              key={r.id}
              className="flex items-center justify-between gap-2 px-3 py-2 text-sm"
            >
              <span className="min-w-0 flex-1 truncate">
                <span className="font-medium">{r.productName ?? "—"}</span>
                <span className="text-muted-foreground">
                  {r.sku ? ` · ${r.sku}` : ""}
                  {r.siteName ? ` · ${r.siteName}` : ""}
                </span>
                <span className="block text-muted-foreground">
                  → {r.type?.name ?? "—"}
                  {r.type ? ` · ${formatCurrency(r.type.unit_cost)}` : ""}
                </span>
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
                      run(() => updateSkuRuleQty(r.id, q))
                  }}
                  className="h-8 w-14 text-right"
                />
              </span>
              {canManage ? (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Remove override"
                  disabled={isPending}
                  onClick={() => run(() => deleteSkuRule(r.id))}
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
          <div className="flex min-w-32 flex-1 flex-col gap-1">
            <Label className="text-xs">SKU code</Label>
            <Input
              value={sku}
              onChange={(e) => setSku(e.target.value)}
              placeholder="e.g. FREE18"
            />
          </div>
          <div className="flex min-w-40 flex-1 flex-col gap-1">
            <Label className="text-xs">Packaging</Label>
            <Select value={type} onChange={(e) => setType(e.target.value)}>
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
              value={qty}
              onChange={(e) => setQty(e.target.value)}
            />
          </div>
          <Button
            disabled={isPending || !sku.trim() || !type}
            onClick={() =>
              run(async () => {
                const res = await addSkuRuleByCode(sku, type, Number(qty || 1))
                if (res.ok) {
                  setSku("")
                  setQty("1")
                }
                return res
              })
            }
          >
            <Plus data-icon="inline-start" /> Add override
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          You don&apos;t have permission to change these rules.
        </p>
      )}
    </div>
  )
}
