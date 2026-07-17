"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { AlertCircle, Check } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { setPackagingReorderPoint } from "./actions"

export type ThresholdRow = {
  id: string
  name: string
  on_hand: number
  reorder_point: number | null
}

/**
 * Per-type "alert at" editor. Sets the central reorder point that drives the
 * red portal-wide low-stock banner. Manager-editable (the RPC gates on
 * admin/operator/manager); read-only for everyone else.
 */
export function PackagingThresholds({
  rows,
  canManage,
}: {
  rows: ThresholdRow[]
  canManage: boolean
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  // Draft threshold text per type id, seeded from the saved value.
  const [drafts, setDrafts] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      rows.map((r) => [r.id, r.reorder_point === null ? "" : String(r.reorder_point)]),
    ),
  )

  function save(id: string) {
    setError(null)
    const raw = drafts[id] ?? ""
    const point = raw.trim() === "" ? null : Number(raw)
    startTransition(async () => {
      const res = await setPackagingReorderPoint(id, point)
      if (!res.ok) setError(res.error)
      else router.refresh()
    })
  }

  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No active packaging types yet. Add them below, then set an alert quantity.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {error ? (
        <div className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
        {rows.map((r) => {
          const reorder = r.reorder_point
          const low = reorder !== null && r.on_hand <= reorder
          const negative = r.on_hand < 0
          return (
            <li
              key={r.id}
              className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className="font-medium">{r.name}</span>
                {negative ? (
                  <Badge variant="destructive">{r.on_hand} on hand</Badge>
                ) : low ? (
                  <Badge variant="warning">{r.on_hand} on hand · low</Badge>
                ) : (
                  <Badge variant="muted" className="tabular-nums">
                    {r.on_hand} on hand
                  </Badge>
                )}
              </div>

              <div className="flex items-center gap-1.5">
                <Label
                  htmlFor={`alert-${r.id}`}
                  className="text-xs text-muted-foreground"
                >
                  Alert at
                </Label>
                <Input
                  id={`alert-${r.id}`}
                  type="number"
                  min="0"
                  step="1"
                  value={drafts[r.id] ?? ""}
                  onChange={(e) =>
                    setDrafts((d) => ({ ...d, [r.id]: e.target.value }))
                  }
                  placeholder="none"
                  className="w-24"
                  disabled={!canManage || isPending}
                />
                {canManage ? (
                  <Button
                    size="icon-sm"
                    variant="secondary"
                    aria-label={`Save alert quantity for ${r.name}`}
                    disabled={isPending}
                    onClick={() => save(r.id)}
                  >
                    <Check />
                  </Button>
                ) : null}
              </div>
            </li>
          )
        })}
      </ul>

      <p className="text-xs text-muted-foreground">
        When a type&apos;s stock drops to or below its alert quantity, a red
        low-stock banner shows at the top of the portal for everyone. Leave blank
        to turn the alert off for that type.
      </p>
    </div>
  )
}
