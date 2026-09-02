"use client"

import { useState, useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { AlertTriangle } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { formatDateTime } from "@/lib/format"
import { resolveOrderIdCollision } from "./actions"

export type OrderIdCollision = {
  id: string
  source: string
  external_order_id: string
  existing_wms_order_id: string
  existing_entered_at: string | null
  incoming_created_at: string | null
  note: string
  detected_at: string
  order_number: string | null
}

/**
 * A store re-used an external_order_id WMS already had on file for a
 * different order — applyWooLifecycleUpdate refused to guess which one is
 * real and left the existing WMS order untouched (migration 0107). The order
 * this incoming webhook actually belongs to likely still needs to be created
 * by hand; this card is the only place that surfaces that.
 */
export function OrderIdCollisionsCard({ rows }: { rows: OrderIdCollision[] }) {
  if (rows.length === 0) return null

  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base text-destructive">
          <AlertTriangle className="size-4" /> Order id collisions
        </CardTitle>
        <CardDescription>
          The store sent an order number WMS already has on file for a
          different order (a reused/reset id). WMS left the existing order
          alone — the real order below likely still needs to be created
          manually. Resolve once it&apos;s handled.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {rows.map((row) => (
          <CollisionRow key={row.id} row={row} />
        ))}
      </CardContent>
    </Card>
  )
}

function CollisionRow({ row }: { row: OrderIdCollision }) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [note, setNote] = useState("")
  const [error, setError] = useState<string | null>(null)

  function resolve() {
    setError(null)
    startTransition(async () => {
      const res = await resolveOrderIdCollision(row.id, note)
      if (!res.ok) setError(res.error)
      else router.refresh()
    })
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">
          {row.source} #{row.external_order_id}
        </span>
        <span className="text-xs text-muted-foreground">
          Detected {formatDateTime(row.detected_at)}
        </span>
      </div>
      <p className="text-muted-foreground">{row.note}</p>
      <p className="text-xs text-muted-foreground">
        Existing WMS order:{" "}
        <Link
          href={`/orders/${row.existing_wms_order_id}`}
          className="underline"
        >
          {row.order_number ?? row.existing_wms_order_id}
        </Link>{" "}
        (entered {row.existing_entered_at ? formatDateTime(row.existing_entered_at) : "unknown"})
        — incoming order dated{" "}
        {row.incoming_created_at ? formatDateTime(row.incoming_created_at) : "unknown"}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="How was this handled? (optional)"
          className="h-8 max-w-xs text-xs"
        />
        <Button size="sm" variant="outline" disabled={isPending} onClick={resolve}>
          Mark resolved
        </Button>
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  )
}
