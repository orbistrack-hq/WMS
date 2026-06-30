"use client"

import { useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { AlertCircle, Check, PackagePlus, SlidersHorizontal, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select } from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { formatCurrency } from "@/lib/format"
import {
  adjustPackaging,
  receivePackaging,
  setPackagingReorderPoint,
} from "./actions"

export type StockSite = { id: string; name: string }

export type StockType = {
  id: string
  name: string
  kind: string
  unit_cost: number
}

export type StockLevel = {
  packaging_type_id: string
  site_id: string
  on_hand: number
  reorder_point: number | null
}

const KIND_LABEL: Record<string, string> = {
  box: "Box",
  shipping_label: "Shipping label",
  jar: "Jar",
  jar_label: "Jar label",
  vacuum_bag: "Vacuum bag",
  custom: "Custom",
}

export function PackagingStock({
  sites,
  types,
  levels,
}: {
  sites: StockSite[]
  types: StockType[]
  levels: StockLevel[]
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [siteId, setSiteId] = useState<string>(sites[0]?.id ?? "")
  const [openId, setOpenId] = useState<string | null>(null)

  // Level lookup for the selected site: type_id -> level.
  const bySite = useMemo(() => {
    const m = new Map<string, StockLevel>()
    for (const l of levels) if (l.site_id === siteId) m.set(l.packaging_type_id, l)
    return m
  }, [levels, siteId])

  if (sites.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Add a site first — packaging stock is tracked per location.
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

      <div className="flex items-end gap-2">
        <div className="flex flex-col gap-1">
          <Label className="text-xs">Location</Label>
          <Select
            value={siteId}
            onChange={(e) => {
              setSiteId(e.target.value)
              setOpenId(null)
              setError(null)
            }}
            className="w-56"
          >
            {sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {types.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No active packaging types. Add some above first.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
          {types.map((t) => {
            const lvl = bySite.get(t.id)
            const onHand = lvl?.on_hand ?? 0
            const reorder = lvl?.reorder_point ?? null
            const low = reorder !== null && onHand <= reorder
            const negative = onHand < 0
            return (
              <li key={t.id} className="flex flex-col gap-2 px-3 py-2 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 flex-col">
                    <span className="font-medium">{t.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {KIND_LABEL[t.kind] ?? t.kind} ·{" "}
                      {formatCurrency(t.unit_cost)} each ·{" "}
                      {formatCurrency(onHand * t.unit_cost)} on hand
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {negative ? (
                      <Badge variant="destructive">{onHand}</Badge>
                    ) : low ? (
                      <Badge variant="warning">{onHand} · low</Badge>
                    ) : (
                      <Badge variant="muted" className="tabular-nums">
                        {onHand}
                      </Badge>
                    )}
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="Manage stock"
                      disabled={isPending}
                      onClick={() => {
                        setError(null)
                        setOpenId(openId === t.id ? null : t.id)
                      }}
                    >
                      <SlidersHorizontal />
                    </Button>
                  </div>
                </div>

                {openId === t.id ? (
                  <StockPanel
                    typeId={t.id}
                    siteId={siteId}
                    reorder={reorder}
                    isPending={isPending}
                    onError={setError}
                    onDone={() => {
                      setOpenId(null)
                      router.refresh()
                    }}
                    run={(fn) => {
                      setError(null)
                      startTransition(async () => {
                        const res = await fn()
                        if (!res.ok) setError(res.error)
                        else {
                          setOpenId(null)
                          router.refresh()
                        }
                      })
                    }}
                  />
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">
        Packaging is consumed automatically when an order is packed (counted once
        per combined-order group). Receiving adds stock; an adjustment is a
        counted correction. Stock can read negative if more was used than
        received — receive or adjust to reconcile.
      </p>
    </div>
  )
}

type Res = { ok: true } | { ok: false; error: string }

function StockPanel({
  typeId,
  siteId,
  reorder,
  isPending,
  onError,
  onDone,
  run,
}: {
  typeId: string
  siteId: string
  reorder: number | null
  isPending: boolean
  onError: (e: string) => void
  onDone: () => void
  run: (fn: () => Promise<Res>) => void
}) {
  const [recvQty, setRecvQty] = useState("")
  const [recvNote, setRecvNote] = useState("")
  const [adjDelta, setAdjDelta] = useState("")
  const [adjNote, setAdjNote] = useState("")
  const [reorderPt, setReorderPt] = useState(reorder === null ? "" : String(reorder))

  return (
    <div className="grid gap-3 rounded-lg border border-border bg-muted/30 p-3 sm:grid-cols-3">
      {/* Receive */}
      <div className="flex flex-col gap-1">
        <Label className="text-xs">Receive</Label>
        <div className="flex gap-1">
          <Input
            type="number"
            min="1"
            step="1"
            value={recvQty}
            onChange={(e) => setRecvQty(e.target.value)}
            placeholder="qty"
            className="w-20"
          />
          <Input
            value={recvNote}
            onChange={(e) => setRecvNote(e.target.value)}
            placeholder="note (optional)"
          />
          <Button
            size="icon-sm"
            aria-label="Receive"
            disabled={isPending || !(Number(recvQty) > 0)}
            onClick={() =>
              run(() =>
                receivePackaging(typeId, siteId, Number(recvQty), recvNote),
              )
            }
          >
            <PackagePlus />
          </Button>
        </div>
      </div>

      {/* Adjust (signed, note required) */}
      <div className="flex flex-col gap-1">
        <Label className="text-xs">Adjust (±)</Label>
        <div className="flex gap-1">
          <Input
            type="number"
            step="1"
            value={adjDelta}
            onChange={(e) => setAdjDelta(e.target.value)}
            placeholder="±qty"
            className="w-20"
          />
          <Input
            value={adjNote}
            onChange={(e) => setAdjNote(e.target.value)}
            placeholder="reason (required)"
          />
          <Button
            size="icon-sm"
            aria-label="Adjust"
            disabled={isPending || !Number(adjDelta) || !adjNote.trim()}
            onClick={() => {
              if (!adjNote.trim()) {
                onError("A note is required for manual adjustments.")
                return
              }
              run(() =>
                adjustPackaging(typeId, siteId, Number(adjDelta), adjNote),
              )
            }}
          >
            <Check />
          </Button>
        </div>
      </div>

      {/* Reorder point */}
      <div className="flex flex-col gap-1">
        <Label className="text-xs">Low-stock at</Label>
        <div className="flex gap-1">
          <Input
            type="number"
            min="0"
            step="1"
            value={reorderPt}
            onChange={(e) => setReorderPt(e.target.value)}
            placeholder="none"
            className="w-24"
          />
          <Button
            size="icon-sm"
            variant="secondary"
            aria-label="Save reorder point"
            disabled={isPending}
            onClick={() =>
              run(() =>
                setPackagingReorderPoint(
                  typeId,
                  siteId,
                  reorderPt === "" ? null : Number(reorderPt),
                ),
              )
            }
          >
            <Check />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Close"
            onClick={onDone}
          >
            <X />
          </Button>
        </div>
      </div>
    </div>
  )
}
