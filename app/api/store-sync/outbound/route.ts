import { NextResponse } from "next/server"

import { createAdminClient } from "@/lib/supabase/admin"
import { drainOutboundInventory } from "@/lib/store-sync/outbound"
import { verifyWorkerSecret } from "@/lib/store-sync/queue"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
// Give the drain room to run and RECORD outcomes rather than being killed
// mid-flight (which would strand freshly-claimed jobs in 'processing'). Keep the
// in-code deadline below this so we always return cleanly. 60s is the Vercel
// Hobby cap; raise on Pro if needed.
export const maxDuration = 60

/**
 * Scheduled drain endpoint for outbound inventory sync — the safety net behind
 * the server-action kicks. Point a QStash schedule (forwarding the
 * x-wms-worker-key header) or a Vercel Cron (Authorization: Bearer CRON_SECRET)
 * at this route. It first reaps jobs stranded in 'processing' by a previously
 * killed run, then claims and pushes pending jobs; anything that fails retries
 * with backoff via the durable queue.
 *
 * Auth: accepts EITHER the forwarded worker secret (QStash / manual) OR Vercel's
 * cron Authorization bearer. Fail closed when neither is configured/valid.
 */
function authorized(req: Request): boolean {
  if (verifyWorkerSecret(req.headers.get("x-wms-worker-key"))) return true
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

    // Reaper: rescue jobs left 'processing' by a drain that was killed mid-run
    // (serverless timeout) or that hit its time budget last pass. Resets stale
    // rows back to 'pending' so they retry this run instead of sticking forever.
    let reaped = 0
    const { data: reapData } = await admin.rpc("reap_stuck_outbound_inventory_jobs")
    if (typeof reapData === "number") reaped = reapData

    // Bound the drain below maxDuration so we finish and record outcomes.
    const summary = await drainOutboundInventory(admin, {
      limit: 100,
      deadlineMs: 50_000,
    })
    return NextResponse.json({ ok: true, reaped, ...summary }, { status: 200 })
  } catch (err) {
    const message = err instanceof Error ? err.message : "drain failed"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

// GET so a Vercel Cron (which issues GET) can drive it; POST for QStash/manual.
export const GET = handle
export const POST = handle
