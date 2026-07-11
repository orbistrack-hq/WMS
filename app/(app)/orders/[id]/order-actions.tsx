"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import {
  CheckCircle2,
  XCircle,
  Pause,
  Play,
  Merge,
  AlertCircle,
  Undo2,
  RotateCcw,
  PackageCheck,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  cancelOrder,
  combineOrders,
  fulfillOrder,
  markCompletedAtStore,
  reopenOrder,
  returnOrder,
  setStatus,
  toggleHold,
} from "../actions"
import {
  LABEL_STATUSES,
  STATUS_BADGE,
  isActive,
  type OrderStatus,
} from "@/lib/orders/types"

type Combinable = { id: string; order_number: string }

export function OrderActions({
  orderId,
  status,
  onHold,
  combinable,
}: {
  orderId: string
  status: OrderStatus
  onHold: boolean
  combinable: Combinable[]
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  function run(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null)
    startTransition(async () => {
      const res = await fn()
      if (!res.ok) setError(res.error ?? "Something went wrong.")
      else router.refresh()
    })
  }

  const active = isActive(status)

  if (!active) {
    return (
      <div className="flex flex-col gap-3">
        {error ? (
          <div className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}
        <p className="text-sm text-muted-foreground">
          This order is {STATUS_BADGE[status].label.toLowerCase()}.
          {status === "fulfilled"
            ? " If it bounced back to us, mark it returned to restock it."
            : status === "returned"
              ? " Re-open it to ship again — this re-reserves its stock."
              : " It can no longer change."}
        </p>
        {status === "fulfilled" ? (
          <Button
            size="sm"
            variant="outline"
            className="w-fit"
            disabled={isPending}
            onClick={() => run(() => returnOrder(orderId))}
          >
            <Undo2 data-icon="inline-start" /> Mark returned
          </Button>
        ) : null}
        {status === "returned" ? (
          <Button
            size="sm"
            className="w-fit"
            disabled={isPending}
            onClick={() => run(() => reopenOrder(orderId))}
          >
            <RotateCcw data-icon="inline-start" /> Re-open order
          </Button>
        ) : null}
      </div>
    )
  }

  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div className="flex flex-col gap-4">
      {error ? (
        <div className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      {/* Status stepper (label-only moves) */}
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted-foreground">
          Stage
        </span>
        <div className="flex flex-wrap gap-1.5">
          {LABEL_STATUSES.map((s) => (
            <Button
              key={s}
              size="sm"
              variant={s === status ? "default" : "outline"}
              disabled={isPending || s === status}
              onClick={() => run(() => setStatus(orderId, s))}
            >
              {STATUS_BADGE[s].label}
            </Button>
          ))}
        </div>
      </div>

      {/* Lifecycle + hold */}
      <div className="flex flex-wrap gap-1.5">
        <Button
          size="sm"
          disabled={isPending}
          onClick={() => run(() => fulfillOrder(orderId))}
        >
          <CheckCircle2 data-icon="inline-start" /> Fulfill
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={isPending}
          onClick={() => run(() => toggleHold(orderId, !onHold))}
        >
          {onHold ? (
            <>
              <Play data-icon="inline-start" /> Release hold
            </>
          ) : (
            <>
              <Pause data-icon="inline-start" /> Hold
            </>
          )}
        </Button>
        <Button
          size="sm"
          variant="destructive"
          disabled={isPending}
          onClick={() => {
            if (
              confirm(
                "Cancel this order? Reserved stock will be released back to inventory.",
              )
            )
              run(() => cancelOrder(orderId))
          }}
        >
          <XCircle data-icon="inline-start" /> Cancel
        </Button>
      </div>

      {/* Completed at the store — shipped outside OT (e.g. ShipStation) */}
      <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <PackageCheck className="size-4" /> Completed at the store
        </div>
        <p className="text-xs text-muted-foreground">
          Use when this order already shipped at the store and just needs
          recording here. It&apos;s marked completed and flagged as a store
          completion. Pick whether to leave stock alone (it already left the
          shelf before OT tracked it) or deplete on-hand.
        </p>
        <div className="flex flex-wrap gap-1.5">
          <Button
            size="sm"
            variant="secondary"
            disabled={isPending}
            onClick={() => {
              if (
                confirm(
                  "Mark completed at the store WITHOUT changing stock? Its reservation is released and any backorder cleared, but on-hand is left as-is because the item already shipped.",
                )
              )
                run(() => markCompletedAtStore(orderId))
            }}
          >
            <PackageCheck data-icon="inline-start" /> Completed — leave stock
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={isPending}
            onClick={() => {
              if (
                confirm(
                  "Mark completed at the store AND deplete on-hand for its items? Use only if OT's stock should reflect this shipment.",
                )
              )
                run(() => markCompletedAtStore(orderId, { consume: true }))
            }}
          >
            Completed — deplete stock
          </Button>
        </div>
      </div>

      {/* Combine candidates */}
      {combinable.length > 0 ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
          <div className="flex items-center gap-1.5 text-sm font-medium">
            <Merge className="size-4" /> Combinable orders
            <Badge variant="muted">{combinable.length}</Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            Same customer and ship-to within 24 hours. Combining groups them
            into one fulfillment — one box and one label, consumables summed.
          </p>
          <div className="flex flex-col gap-1">
            {combinable.map((c) => (
              <label
                key={c.id}
                className="flex items-center gap-2 text-sm"
              >
                <input
                  type="checkbox"
                  className="size-4 accent-primary"
                  checked={selected.has(c.id)}
                  onChange={() => toggleSelected(c.id)}
                />
                {c.order_number}
              </label>
            ))}
          </div>
          <Button
            size="sm"
            variant="secondary"
            className="self-start"
            disabled={isPending || selected.size === 0}
            onClick={() =>
              run(() => combineOrders([orderId, ...Array.from(selected)]))
            }
          >
            <Merge data-icon="inline-start" /> Combine selected
          </Button>
        </div>
      ) : null}
    </div>
  )
}
