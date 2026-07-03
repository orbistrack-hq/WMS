"use client"

import { useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { AlertCircle, AlertTriangle, Check } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import { formatGrams } from "@/lib/format"
import { applyWeightBackfill, type BackfillGroup } from "./actions"

export function BackfillReview({ groups }: { groups: BackfillGroup[] }) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{
    moved: number
    collisions: number
    groups: number
  } | null>(null)

  // Everything selected by default; groups whose numbers collide are flagged so
  // the operator sees them before confirming, but can still be deselected.
  const [selected, setSelected] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(groups.map((g) => [g.strain, true])),
  )

  const selectedGroups = useMemo(
    () => groups.filter((g) => selected[g.strain]),
    [groups, selected],
  )
  const selectedCollisions = selectedGroups.reduce(
    (n, g) => n + g.collisions.length,
    0,
  )

  function apply() {
    setError(null)
    const payload = selectedGroups.map((g) => ({
      strain: g.strain,
      members: g.members.map((m) => ({ product_id: m.productId, grams: m.grams })),
    }))
    if (payload.length === 0) return setError("Select at least one group.")
    startTransition(async () => {
      const res = await applyWeightBackfill(payload)
      if (!res.ok) return setError(res.error)
      setResult({ moved: res.moved, collisions: res.collisions, groups: res.groups })
      router.refresh()
    })
  }

  if (groups.length === 0) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          {result
            ? `Done — moved ${result.moved} child SKUs into ${result.groups} strains${
                result.collisions
                  ? `, ${result.collisions} left for manual review`
                  : ""
              }.`
            : "No split weight products found. Your catalog is already grouped."}
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {error ? (
        <div className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {groups.length} strain{groups.length === 1 ? "" : "s"} to group ·{" "}
          {selectedGroups.length} selected
          {selectedCollisions > 0 ? (
            <span className="text-amber-600 dark:text-amber-400">
              {" "}
              · {selectedCollisions} conflicting weight
              {selectedCollisions === 1 ? "" : "s"} will be left for review
            </span>
          ) : null}
        </p>
        <Button onClick={apply} disabled={isPending || selectedGroups.length === 0}>
          {isPending ? "Grouping…" : `Confirm all (${selectedGroups.length})`}
        </Button>
      </div>

      {groups.map((g) => {
        const hasCollision = g.collisions.length > 0
        const isSel = !!selected[g.strain]
        return (
          <Card
            key={g.strain}
            className={cn(
              hasCollision && "border-amber-500/40",
              !isSel && "opacity-60",
            )}
          >
            <CardContent className="flex flex-col gap-3 py-4">
              <div className="flex items-start gap-3">
                <input
                  type="checkbox"
                  className="mt-1 size-4 accent-primary"
                  checked={isSel}
                  onChange={(e) =>
                    setSelected((prev) => ({
                      ...prev,
                      [g.strain]: e.target.checked,
                    }))
                  }
                  aria-label={`Select ${g.strain}`}
                />
                <div className="flex flex-1 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{g.strain}</span>
                    {g.canonicalExists ? (
                      <Badge variant="muted">existing parent</Badge>
                    ) : (
                      <Badge variant="outline">new parent</Badge>
                    )}
                    {g.weights.map((w) => (
                      <Badge key={w} variant="secondary">
                        {formatGrams(w)}
                      </Badge>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {g.childCount} child SKU{g.childCount === 1 ? "" : "s"} across{" "}
                    {g.members.length} product{g.members.length === 1 ? "" : "s"}
                    {" → "}one &ldquo;{g.strain}&rdquo; parent
                  </p>
                </div>
              </div>

              {hasCollision ? (
                <div className="flex flex-col gap-1 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                  <span className="flex items-center gap-1.5 font-medium">
                    <AlertTriangle className="size-3.5" /> Conflicting weights —
                    left separate for manual review
                  </span>
                  {g.collisions.map((c, i) => (
                    <span key={i}>
                      {c.siteName} · {formatGrams(c.grams)} — {c.onHand} on hand
                    </span>
                  ))}
                </div>
              ) : null}
            </CardContent>
          </Card>
        )
      })}

      {result ? (
        <div className="flex items-center gap-2 rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400">
          <Check className="size-4 shrink-0" />
          Moved {result.moved} child SKUs into {result.groups} strains
          {result.collisions
            ? `, ${result.collisions} left for manual review`
            : ""}
          .
        </div>
      ) : null}
    </div>
  )
}
