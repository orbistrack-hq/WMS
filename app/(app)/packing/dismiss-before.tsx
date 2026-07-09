"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { CalendarX2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { dismissStaleGroups } from "./actions"

/**
 * Bulk cleanup: hide every open packing group whose window date is before the
 * chosen cutoff. Non-destructive (orders/inventory/billing untouched) and
 * reversible per group — handy for onboarding, to clear out stale, already
 * fulfilled orders in one pass. Operator-level (admin/operator/manager); the
 * server RPC enforces the permission.
 */
export function DismissBefore() {
  const router = useRouter()
  const [date, setDate] = useState("")
  const [open, setOpen] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function run() {
    if (!date) {
      setError("Pick a cutoff date.")
      return
    }
    setError(null)
    setMsg(null)
    startTransition(async () => {
      // Interpret the picked calendar day as its start (local midnight).
      const res = await dismissStaleGroups(`${date}T00:00:00`)
      if (!res.ok) {
        setError(res.error)
        return
      }
      setMsg(
        res.count === 0
          ? "No open groups were older than that date."
          : `Hid ${res.count} group${res.count === 1 ? "" : "s"} from the queue.`,
      )
      setDate("")
      setOpen(false)
      router.refresh()
    })
  }

  if (!open) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          <CalendarX2 className="size-4" /> Hide orders before a date…
        </Button>
        {msg ? (
          <span className="text-sm text-muted-foreground">{msg}</span>
        ) : null}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-card px-4 py-3">
      <p className="text-sm">
        Hide every open group with a window date before the cutoff. This is
        reversible and doesn&apos;t touch orders, inventory, or billing — it just
        clears stale rows off the packing queue.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="w-44"
          aria-label="Hide groups before this date"
        />
        <Button onClick={run} disabled={pending || !date}>
          {pending ? "Hiding…" : "Hide older groups"}
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            setOpen(false)
            setError(null)
          }}
          disabled={pending}
        >
          Cancel
        </Button>
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  )
}
