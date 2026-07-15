import { NextResponse } from "next/server"

import { createAdminClient } from "@/lib/supabase/admin"
import { sweepStoreCompleted } from "@/lib/store-sync/mark-completed-sweep"
import { verifyWorkerSecret } from "@/lib/store-sync/queue"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
// Bound the in-code deadline below this so we always return cleanly. 60s is the
// Vercel Hobby cap; raise on Pro if a store has many recent completions.
export const maxDuration = 60

/**
 * Nightly safety-net for the store-completion marker. Re-fetches recently
 * completed Woo orders and stamps store_completed_at on the matching active WMS
 * order (mark-only — never fulfils). Catches completions whose webhook was
 * missed or whose topic was never registered, so nobody has to run a reconcile
 * by hand. Driven by a Vercel Cron (Authorization: Bearer CRON_SECRET) or a
 * manual call forwarding the worker secret (x-wms-worker-key / ?key=).
 */
function authorized(req: Request): boolean {
  if (verifyWorkerSecret(req.headers.get("x-wms-worker-key"))) return true
  try {
    if (verifyWorkerSecret(new URL(req.url).searchParams.get("key"))) return true
  } catch {
    // ignore malformed URL
  }
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret) {
    const auth = req.headers.get("authorization")
    if (auth === `Bearer ${cronSecret}`) return true
  }
  return false
}

async function handle(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  }
  try {
    const admin = createAdminClient()
    const summary = await sweepStoreCompleted(admin, { deadlineMs: 50_000 })
    return NextResponse.json({ ok: true, ...summary }, { status: 200 })
  } catch (err) {
    const message = err instanceof Error ? err.message : "sweep failed"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

// GET so a Vercel Cron (which issues GET) can drive it; POST for manual runs.
export const GET = handle
export const POST = handle
