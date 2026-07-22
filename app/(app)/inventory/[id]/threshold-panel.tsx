"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { AlertCircle, Check } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { setChildLowStockThreshold } from "../actions"

/**
 * Per-SKU low-stock threshold editor (migration 0079). Blank clears the override
 * (falls back to the app-wide default); 0 silences the alert for this SKU.
 */
export function ThresholdPanel({
  childSkuId,
  current,
  effective,
  onHand,
  canManage,
}: {
  childSkuId: string
  current: number | null
  effective: number
  onHand: number
  canManage: boolean
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState(current === null ? "" : String(current))

  const isLow = effective >= 1 && onHand <= effective

  function save() {
    setError(null)
    const raw = draft.trim()
    const point = raw === "" ? null : Number(raw)
    startTransition(async () => {
      const res = await setChildLowStockThreshold([childSkuId], point)
      if (!res.ok) setError(res.error)
      else router.refresh()
    })
  }

  return (
    <div className="flex flex-col gap-3 text-sm">
      {error ? (
        <div className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground">Status</span>
        <span className={isLow ? "font-medium text-amber-700 dark:text-amber-400" : ""}>
          {isLow ? `Low — ${onHand} on hand` : "OK"}
        </span>
      </div>

      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground">Effective threshold</span>
        <span className="tabular-nums">
          {effective === 0 ? "Silenced" : `Alert at ${effective}`}
          {current === null ? (
            <span className="ml-1 text-xs opacity-60">(default)</span>
          ) : null}
        </span>
      </div>

      {canManage ? (
        <div className="flex items-end gap-1.5">
          <div className="flex flex-1 flex-col gap-1">
            <label
              htmlFor="sku-threshold"
              className="text-xs text-muted-foreground"
            >
              This SKU&apos;s threshold (blank = default, 0 = silence)
            </label>
            <Input
              id="sku-threshold"
              type="number"
              min="0"
              step="1"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="default"
              disabled={isPending}
            />
          </div>
          <Button
            size="icon"
            variant="secondary"
            aria-label="Save threshold"
            disabled={isPending}
            onClick={save}
          >
            <Check />
          </Button>
        </div>
      ) : null}
    </div>
  )
}
