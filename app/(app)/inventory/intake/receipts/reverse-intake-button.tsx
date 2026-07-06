"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Undo2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { reverseIntake } from "../actions"

/**
 * Two-step inline confirm for reversing a bulk intake. The DB enforces the
 * admin/operator guard and blocks the reversal (with a friendly message) when
 * the grams have already been allocated out. On success we refresh.
 */
export function ReverseIntakeButton({ ledgerId }: { ledgerId: string }) {
  const router = useRouter()
  const [confirming, setConfirming] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [pending, startTransition] = React.useTransition()

  function run() {
    setError(null)
    startTransition(async () => {
      const res = await reverseIntake(ledgerId)
      if (!res.ok) {
        setError(res.error)
        setConfirming(false)
        return
      }
      router.refresh()
    })
  }

  if (!confirming) {
    return (
      <div className="flex flex-col items-end gap-1">
        <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
          <Undo2 className="size-4" /> Reverse
        </Button>
        {error ? (
          <p className="text-xs whitespace-pre-line text-destructive">{error}</p>
        ) : null}
      </div>
    )
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <p className="text-xs text-muted-foreground">
        Reverse this intake? Blocked if the grams are already allocated.
      </p>
      <div className="flex gap-2">
        <Button
          variant="destructive"
          size="sm"
          onClick={run}
          disabled={pending}
        >
          {pending ? "Reversing…" : "Yes, reverse"}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setConfirming(false)}
          disabled={pending}
        >
          Cancel
        </Button>
      </div>
      {error ? (
        <p className="text-xs whitespace-pre-line text-destructive">{error}</p>
      ) : null}
    </div>
  )
}
