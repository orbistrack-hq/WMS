import { NextResponse } from "next/server"

import { createAdminClient } from "@/lib/supabase/admin"
import { sweepWooCosts } from "@/lib/woocommerce/cost-sweep"
import { verifyWorkerSecret } from "@/lib/store-sync/queue"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
// Bound the in-code deadline below this so we always return cleanly. 60s is the
// Vercel Hobby cap.
export const maxDuration = 60

/**
 * Nightly pull of Cost-of-Goods values from every active WooCommerce store, so
 * a cost edited without saving the product (COG plugin bulk tools, imports —
 * which fire no product.updated webhook) still lands in WMS by morning.
 * Driven by a Vercel Cron (Authorization: Bearer CRON_SECRET) or a manual call
 * forwarding the worker secret (x-wms-worker-key / ?key=).
 *
 * `?dry=1` reports the cost changes it would make without writing them.
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
  let dryRun = false
  try {
    dryRun = new URL(req.url).searchParams.get("dry") === "1"
  } catch {
    // ignore malformed URL
  }
  try {
    const admin = createAdminClient()
    const summary = await sweepWooCosts(admin, { deadlineMs: 50_000, dryRun })
    return NextResponse.json({ ok: true, dryRun, ...summary }, { status: 200 })
  } catch (err) {
    const message = err instanceof Error ? err.message : "cost sweep failed"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

// GET so a Vercel Cron (which issues GET) can drive it; POST for manual runs.
export const GET = handle
export const POST = handle
