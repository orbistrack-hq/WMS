"use client"

import { useState, useTransition, type ReactNode } from "react"
import { useRouter } from "next/navigation"
import { AlertCircle, Check, PackagePlus, SlidersHorizontal } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { adjustStock, receiveStock } from "../actions"

type Mode = "receive" | "adjust"

export function AdjustPanel({
  childSkuId,
  onHand,
}: {
  childSkuId: string
  onHand: number
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [mode, setMode] = useState<Mode>("receive")
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const [qty, setQty] = useState("")
  const [delta, setDelta] = useState("")
  const [note, setNote] = useState("")

  function reset() {
    setQty("")
    setDelta("")
    setNote("")
  }

  function submit() {
    setError(null)
    setSaved(false)
    startTransition(async () => {
      let res
      if (mode === "receive") {
        const n = Number(qty)
        if (!(n > 0)) {
          setError("Enter a quantity to receive.")
          return
        }
        res = await receiveStock(childSkuId, n, note || null)
      } else {
        const d = Number(delta)
        if (!d) {
          setError("Enter a non-zero adjustment.")
          return
        }
        if (!note.trim()) {
          setError("A note is required for manual adjustments.")
          return
        }
        res = await adjustStock(childSkuId, d, note)
      }
      if (!res.ok) setError(res.error)
      else {
        reset()
        setSaved(true)
        router.refresh()
      }
    })
  }

  const projected =
    mode === "receive"
      ? onHand + (Number(qty) || 0)
      : onHand + (Number(delta) || 0)

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-1 rounded-lg bg-muted p-0.5">
        <ModeButton
          active={mode === "receive"}
          onClick={() => {
            setMode("receive")
            setError(null)
          }}
        >
          <PackagePlus className="size-4" /> Receive
        </ModeButton>
        <ModeButton
          active={mode === "adjust"}
          onClick={() => {
            setMode("adjust")
            setError(null)
          }}
        >
          <SlidersHorizontal className="size-4" /> Adjust
        </ModeButton>
      </div>

      {mode === "receive" ? (
        <div className="flex flex-col gap-1">
          <Label htmlFor="qty">Quantity received</Label>
          <Input
            id="qty"
            type="number"
            min="1"
            step="1"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            placeholder="0"
          />
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          <Label htmlFor="delta">Adjustment (+/−)</Label>
          <Input
            id="delta"
            type="number"
            step="1"
            value={delta}
            onChange={(e) => setDelta(e.target.value)}
            placeholder="e.g. -2 for breakage"
          />
        </div>
      )}

      <div className="flex flex-col gap-1">
        <Label htmlFor="note">
          Note{mode === "adjust" ? " (required)" : " (optional)"}
        </Label>
        <Textarea
          id="note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={
            mode === "receive"
              ? "PO number, supplier…"
              : "Reason for the adjustment…"
          }
        />
      </div>

      <p className="text-xs text-muted-foreground">
        On hand {onHand} →{" "}
        <span className="font-medium text-foreground tabular-nums">
          {projected}
        </span>
      </p>

      {error ? (
        <div className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      <div className="flex items-center gap-2">
        <Button onClick={submit} disabled={isPending}>
          {isPending
            ? "Saving…"
            : mode === "receive"
              ? "Receive stock"
              : "Post adjustment"}
        </Button>
        {saved ? (
          <span className="flex items-center gap-1 text-sm text-emerald-600">
            <Check className="size-4" /> Saved
          </span>
        ) : null}
      </div>
    </div>
  )
}

function ModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex flex-1 items-center justify-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors",
        active
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  )
}
