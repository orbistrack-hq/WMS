"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Undo2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { reverseAllocation } from "../../actions"

/**
 * Two-step inline confirm for reversing an allocation. The DB enforces the
 * admin/operator guard and the "already reserved/sold" block, so a failure comes
 * back as a friendly message we show verbatim (whitespace-pre-line keeps the
 * per-SKU list readable). On success we refresh the server component.
 */
export function ReverseAllocationButton({
  allocationId,
}: {
  allocationId: string
}) {
  const router = useRouter()
  const [confirming, setConfirming] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [pending, startTransition] = React.useTransition()

  function run() {
    setError(null)
    startTransition(async () => {
      const res = await reverseAllocation(allocationId)
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
      <div className="flex flex-col gap-2">
        <Button variant="outline" onClick={() => setConfirming(true)}>
          <Undo2 className="size-4" /> Reverse allocation
        </Button>
        {error ? (
          <p className="text-sm whitespace-pre-line text-destructive">{error}</p>
        ) : null}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <p className="text-sm">
        Reverse this allocation? It pulls each child SKU&apos;s units back,
        credits the pool, and re-syncs the stores. Blocked if any units are
        already reserved or sold.
      </p>
      <div className="flex gap-2">
        <Button variant="destructive" onClick={run} disabled={pending}>
          {pending ? "Reversing…" : "Yes, reverse"}
        </Button>
        <Button
          variant="outline"
          onClick={() => setConfirming(false)}
          disabled={pending}
        >
          Cancel
        </Button>
      </div>
      {error ? (
        <p className="text-sm whitespace-pre-line text-destructive">{error}</p>
      ) : null}
    </div>
  )
}
