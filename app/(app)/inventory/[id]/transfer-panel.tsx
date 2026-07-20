"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { AlertCircle, AlertTriangle, ArrowLeftRight, Check } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { transferStock } from "../actions"

export type TransferSibling = {
  childId: string
  siteName: string | null
  sku: string | null
  cost: number
}

export function TransferPanel({
  sourceChildId,
  available,
  siblings,
}: {
  sourceChildId: string
  available: number
  siblings: TransferSibling[]
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [dest, setDest] = useState(siblings[0]?.childId ?? "")
  const [qty, setQty] = useState("")
  const [note, setNote] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<string[] | null>(null)
  const [saved, setSaved] = useState(false)

  function run(ackWarnings: boolean) {
    setError(null)
    setSaved(false)
    const n = Number(qty)
    if (!dest) {
      setError("Choose a destination site.")
      return
    }
    if (!(n > 0)) {
      setError("Enter a quantity to transfer.")
      return
    }
    if (n > available) {
      setError(`Only ${available} available to transfer.`)
      return
    }
    startTransition(async () => {
      const res = await transferStock(
        sourceChildId,
        dest,
        n,
        note || null,
        ackWarnings,
      )
      if (res.ok) {
        setQty("")
        setNote("")
        setWarnings(null)
        setSaved(true)
        router.refresh()
      } else if ("needsAck" in res) {
        setWarnings(res.warnings)
      } else {
        setError(res.error)
        setWarnings(null)
      }
    })
  }

  const projected = available - (Number(qty) || 0)

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <Label htmlFor="dest">Destination site</Label>
        <select
          id="dest"
          value={dest}
          onChange={(e) => {
            setDest(e.target.value)
            setWarnings(null)
          }}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm"
        >
          {siblings.map((s) => (
            <option key={s.childId} value={s.childId}>
              {s.siteName ?? "—"}
              {s.sku ? ` · ${s.sku}` : ""}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-1">
        <Label htmlFor="tqty">Quantity to transfer</Label>
        <Input
          id="tqty"
          type="number"
          min="1"
          step="1"
          max={available}
          value={qty}
          onChange={(e) => {
            setQty(e.target.value)
            setWarnings(null)
          }}
          placeholder="0"
        />
        <span className="text-xs text-muted-foreground">
          {available} available at this site
        </span>
      </div>

      <div className="flex flex-col gap-1">
        <Label htmlFor="tnote">Note (optional)</Label>
        <Textarea
          id="tnote"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Reason / reference for the transfer…"
        />
      </div>

      <p className="text-xs text-muted-foreground">
        Available here {available} →{" "}
        <span className="font-medium text-foreground tabular-nums">
          {projected}
        </span>
      </p>

      {warnings ? (
        <div className="flex flex-col gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
          <span className="flex items-center gap-2 font-medium">
            <AlertTriangle className="size-4 shrink-0" /> Check before transferring
          </span>
          <ul className="ml-6 list-disc space-y-0.5">
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
          <div className="flex items-center gap-2 pt-1">
            <Button
              size="sm"
              variant="destructive"
              onClick={() => run(true)}
              disabled={isPending}
            >
              Transfer anyway
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setWarnings(null)}
              disabled={isPending}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {error ? (
        <div className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      {!warnings ? (
        <div className="flex items-center gap-2">
          <Button onClick={() => run(false)} disabled={isPending}>
            <ArrowLeftRight className="size-4" />
            {isPending ? "Transferring…" : "Transfer stock"}
          </Button>
          {saved ? (
            <span className="flex items-center gap-1 text-sm text-emerald-600">
              <Check className="size-4" /> Transferred
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
