"use client"

import { useRef, useState } from "react"
import { AlertCircle, Check, Loader2, ShoppingBag, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import type { JobProgress } from "@/lib/store-sync/jobs"

type StepResult = { ok: true; job: JobProgress } | { ok: false; error: string }

/**
 * Drives a resumable past-order import from the browser: start the job, then
 * call `step` (one page each) until done, showing live counts. The heavy work is
 * server-side and chunked, so the Integrations page never blocks on one long
 * request. Closing the tab just pauses the job — re-running resumes it from the
 * saved cursor. Channel-agnostic: the three server actions are passed in.
 */
export function StoreImportRunner({
  connectionId,
  disabled,
  start,
  step,
  cancel,
}: {
  connectionId: string
  disabled?: boolean
  start: (connectionId: string) => Promise<StepResult>
  step: (jobId: string) => Promise<StepResult>
  cancel: (jobId: string) => Promise<StepResult>
}) {
  const [phase, setPhase] = useState<
    "idle" | "running" | "done" | "failed" | "cancelled"
  >("idle")
  const [prog, setProg] = useState<JobProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const cancelRef = useRef(false)
  const jobIdRef = useRef<string | null>(null)

  async function run() {
    setError(null)
    setPhase("running")
    cancelRef.current = false

    const started = await start(connectionId)
    if (!started.ok) {
      setError(started.error)
      setPhase("failed")
      return
    }
    let job = started.job
    jobIdRef.current = job.jobId
    setProg(job)

    while (job.status === "running") {
      if (cancelRef.current) return
      const res = await step(job.jobId)
      if (!res.ok) {
        setError(res.error)
        setPhase("failed")
        return
      }
      job = res.job
      setProg(job)
      // Pace requests: back off when the platform throttled (lastError set while
      // still running), otherwise a short yield between pages.
      await new Promise((r) =>
        setTimeout(r, job.status === "running" && job.lastError ? 1500 : 150),
      )
    }

    if (job.status === "completed") setPhase("done")
    else if (job.status === "cancelled") setPhase("cancelled")
    else {
      setPhase("failed")
      setError(job.lastError ?? "Import failed.")
    }
  }

  async function onCancel() {
    cancelRef.current = true
    setPhase("cancelled")
    const id = jobIdRef.current
    if (id) {
      const r = await cancel(id)
      if (r.ok) setProg(r.job)
    }
  }

  const counts = prog
    ? `${prog.imported} imported · ${prog.duplicates} already in · ${
        prog.needsMapping ? `${prog.needsMapping} need mapping · ` : ""
      }${prog.fetched} fetched`
    : ""

  if (phase === "running") {
    return (
      <div className="flex w-full flex-col gap-1.5 rounded-lg border border-border p-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-sm font-medium">
            <Loader2 className="size-4 animate-spin" /> Importing past orders…
          </span>
          <Button size="sm" variant="ghost" onClick={onCancel}>
            <X data-icon="inline-start" /> Stop
          </Button>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
          <div className="h-full w-1/3 animate-pulse rounded-full bg-primary" />
        </div>
        <span className="text-xs tabular-nums text-muted-foreground">
          Page {prog?.pageCount ?? 0} · {counts}
          {prog?.lastError ? ` · ${prog.lastError}` : ""}
        </span>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1">
      <Button size="sm" variant="outline" disabled={disabled} onClick={run}>
        <ShoppingBag data-icon="inline-start" /> Sync past orders
      </Button>
      {phase === "done" ? (
        <span className="flex items-center gap-1.5 text-xs text-emerald-600">
          <Check className="size-3.5" /> Done — {counts}.
        </span>
      ) : null}
      {phase === "cancelled" ? (
        <span className="text-xs text-muted-foreground">
          Stopped — {counts}. Run again to resume.
        </span>
      ) : null}
      {phase === "failed" && error ? (
        <span className="flex items-start gap-1.5 text-xs text-destructive">
          <AlertCircle className="mt-0.5 size-3.5 shrink-0" /> {error} Run again to
          resume.
        </span>
      ) : null}
    </div>
  )
}
