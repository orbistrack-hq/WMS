import { NextResponse } from "next/server"

import { createAdminClient } from "@/lib/supabase/admin"
import { drainOutboundInventory } from "@/lib/store-sync/outbound"
import { drainOutboundOrders } from "@/lib/store-sync/outbound-orders"
import { verifyWorkerSecret } from "@/lib/store-sync/queue"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Scheduled drain endpoint for BOTH outbound queues — the safety net behind the
 * immediate fire-and-forget kicks. Point a QStash schedule (forwarding the
 * x-wms-worker-key header) or a Vercel Cron (Authorization: Bearer CRON_SECRET)
 * at this route. It drains outbound inventory (stock -> store) and outbound
 * orders (fulfillment -> store); anything that fails retries with backoff via
 * the durable queues.
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
    const [inventory, orders] = await Promise.all([
      drainOutboundInventory(admin, { limit: 100 }),
      drainOutboundOrders(admin, { limit: 100 }),
    ])
    return NextResponse.json({ ok: true, inventory, orders }, { status: 200 })
  } catch (err) {
    const message = err instanceof Error ? err.message : "drain failed"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

// GET so a Vercel Cron (which issues GET) can drive it; POST for QStash/manual.
export const GET = handle
export const POST = handle
