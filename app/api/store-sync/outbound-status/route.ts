import { NextResponse } from "next/server"

import { createAdminClient } from "@/lib/supabase/admin"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Read-only outbound-queue X-ray (temporary — delete after debugging).
 *
 *   GET /api/store-sync/outbound-status
 *
 * Explains WHY a drain reports claimed:0 / reaped:0 while the UI shows jobs as
 * "Sending". Breaks the queue down by status and, for the two states that decide
 * whether the drain can act, splits them further:
 *   - pending:    due (next_attempt_at <= now, claimable) vs backing-off (future)
 *   - processing: stale (idle > 5 min, reapable) vs fresh (a run touched it < 5m)
 * All-processing + all-fresh => a run is actively holding them (or re-claiming
 * every cycle) so the reaper's 5-minute window never trips. All-pending-future
 * => everything is in retry backoff. Includes a few sample last_errors.
 */
export async function GET() {
  const admin = createAdminClient()
  const { data, error } = await admin
    .from("store_outbound_inventory_jobs")
    .select("status, attempts, next_attempt_at, updated_at, last_error, site:sites(name)")
    .limit(2000)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const now = Date.now()
  const STALE_MS = 5 * 60 * 1000
  const rows = (data ?? []) as Array<{
    status: string
    attempts: number | null
    next_attempt_at: string | null
    updated_at: string | null
    last_error: string | null
    site?: { name?: string | null } | null
  }>

  const byStatus: Record<string, number> = {}
  let pendingDue = 0
  let pendingBackoff = 0
  let processingStale = 0
  let processingFresh = 0
  const errorSamples = new Set<string>()
  const bySite: Record<string, number> = {}

  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1
    const siteName = r.site?.name ?? "—"
    bySite[siteName] = (bySite[siteName] ?? 0) + 1

    if (r.status === "pending") {
      const due = !r.next_attempt_at || new Date(r.next_attempt_at).getTime() <= now
      if (due) pendingDue++
      else pendingBackoff++
    }
    if (r.status === "processing") {
      const age = r.updated_at ? now - new Date(r.updated_at).getTime() : Infinity
      if (age > STALE_MS) processingStale++
      else processingFresh++
    }
    if (r.last_error) errorSamples.add(r.last_error.slice(0, 160))
  }

  return NextResponse.json({
    total: rows.length,
    byStatus,
    pending: { due: pendingDue, backingOff: pendingBackoff },
    processing: {
      stale_reapable: processingStale,
      fresh_recentlyTouched: processingFresh,
    },
    bySite,
    recentErrors: [...errorSamples].slice(0, 8),
    note: "stale processing (idle>5m) is what the reaper resets; due pending is what the drain claims",
  })
}
