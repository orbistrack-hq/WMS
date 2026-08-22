import { NextResponse } from "next/server"

import { createAdminClient } from "@/lib/supabase/admin"
import { sweepShipConflicts } from "@/lib/store-sync/ship-conflict-sweep"
import { verifyWorkerSecret } from "@/lib/store-sync/queue"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 60

/**
 * Scheduled cross-check: any order ShipStation shows shipped while OT still
 * shows cancelled gets flagged (orders.ship_conflict_at) so it surfaces on the
 * order without anyone needing to run the /integrations/shipstation screen by
 * hand. Complements the real-time flag in applyWooLifecycleUpdate /
 * applyShopifyLifecycleUpdate, which only fires if the store re-sends a
 * webhook — this catches the order shipping without one. Driven by a Vercel
 * Cron (Authorization: Bearer CRON_SECRET) or a manual call forwarding the
 * worker secret (x-wms-worker-key / ?key=).
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
  const apiKey = process.env.SHIPSTATION_API_KEY
  const apiSecret = process.env.SHIPSTATION_API_SECRET
  if (!apiKey || !apiSecret) {
    return NextResponse.json(
      { error: "ShipStation API key/secret not configured" },
      { status: 200 },
    )
  }
  try {
    const admin = createAdminClient()
    const summary = await sweepShipConflicts(admin, apiKey, apiSecret)
    return NextResponse.json({ ok: true, ...summary }, { status: 200 })
  } catch (err) {
    const message = err instanceof Error ? err.message : "sweep failed"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

// GET so a Vercel Cron (which issues GET) can drive it; POST for manual runs.
export const GET = handle
export const POST = handle
