"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Check, Wallet } from "lucide-react"

import { Button } from "@/components/ui/button"
import { backfillPickFees } from "./actions"

/**
 * Fill in pick fees on orders that shipped without one.
 *
 * Two-step: the first press asks for confirmation, the second runs it. This
 * writes billable charges, and the count is usually large enough that a
 * misfired click is not obvious afterwards — so it does not fire on one press.
 *
 * The charge is dated from each order's own fulfilment date, so the rate that
 * applied then is the rate used. Running it twice is harmless: the underlying
 * function leaves an existing charge alone.
 */
export function BackfillPickFeesButton({ orderIds }: { orderIds: string[] }) {
  const router = useRouter()
  const [armed, setArmed] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function run() {
    setError(null)
    startTransition(async () => {
      const res = await backfillPickFees(orderIds)
      setArmed(false)
      if (!res.ok) {
        setError(res.error)
        return
      }
      const parts = [`Charged ${res.charged}`]
      if (res.skipped > 0) parts.push(`${res.skipped} already had a fee`)
      if (res.failed > 0) parts.push(`${res.failed} failed`)
      setResult(parts.join(" · "))
      if (res.firstError) setError(`First failure: ${res.firstError}`)
      router.refresh()
    })
  }

  if (result) {
    return (
      <div className="flex flex-col gap-1">
        <span className="inline-flex items-center gap-1.5 text-sm font-medium text-green-700 dark:text-green-400">
          <Check className="size-4" />
          {result}
        </span>
        {error ? <span className="text-xs text-destructive">{error}</span> : null}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        {armed ? (
          <>
            <Button size="sm" onClick={run} disabled={pending}>
              {pending ? "Recording…" : `Yes, charge ${orderIds.length}`}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setArmed(false)}
              disabled={pending}
            >
              Cancel
            </Button>
          </>
        ) : (
          <Button size="sm" variant="outline" onClick={() => setArmed(true)}>
            <Wallet className="size-4" />
            Record the missing pick fees
          </Button>
        )}
      </div>
      {armed ? (
        <span className="text-xs text-muted-foreground">
          Charges {orderIds.length} {orderIds.length === 1 ? "order" : "orders"} at the rate that
          applied on the day each one shipped. Orders that already have a fee are left alone.
        </span>
      ) : null}
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </div>
  )
}
