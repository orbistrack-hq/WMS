"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { AlertCircle, Check, ClipboardCheck, PackageCheck } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { packGroup } from "../actions"

export function PackConfirm({
  groupId,
  initialNotes,
  needsPacking,
  pickComplete,
}: {
  groupId: string
  initialNotes: string | null
  needsPacking: boolean
  pickComplete: boolean
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [notes, setNotes] = useState(initialNotes ?? "")

  // Packing is gated on picking being finished (enforced again in pack_group).
  const blockedOnPicking = needsPacking && !pickComplete

  function submit() {
    setError(null)
    setSaved(false)
    startTransition(async () => {
      const res = await packGroup(groupId, notes || null)
      if (!res.ok) setError(res.error)
      else {
        setSaved(true)
        router.refresh()
      }
    })
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <Label htmlFor="packing-notes">Packing notes</Label>
        <Textarea
          id="packing-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Fragile, special handling, partial pack…"
        />
      </div>

      {error ? (
        <div className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      <div className="flex items-center gap-2">
        <Button onClick={submit} disabled={isPending || blockedOnPicking}>
          <PackageCheck data-icon="inline-start" />
          {needsPacking ? "Confirm packed" : "Save note"}
        </Button>
        {saved ? (
          <span className="flex items-center gap-1 text-sm text-emerald-600">
            <Check className="size-4" /> Saved
          </span>
        ) : null}
      </div>

      {blockedOnPicking ? (
        <div className="flex flex-col items-start gap-1.5 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          <span>Finish picking this group before packing it.</span>
          <Link
            href={`/packing/${groupId}/pick`}
            className="inline-flex items-center gap-1 font-medium underline"
          >
            <ClipboardCheck className="size-3.5" /> Go to picking
          </Link>
        </div>
      ) : needsPacking ? (
        <p className="text-xs text-muted-foreground">
          Confirming advances every open order in this group to{" "}
          <span className="font-medium">Packed</span>. Fulfillment and shipping
          happen from the order.
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          All orders in this group are already packed.
        </p>
      )}
    </div>
  )
}
