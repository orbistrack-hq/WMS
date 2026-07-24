import { NextResponse } from "next/server"

import { createAdminClient } from "@/lib/supabase/admin"
import { reactivateWooWebhooks } from "@/lib/store-sync/reactivate-webhooks"
import { verifyWorkerSecret } from "@/lib/store-sync/queue"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
// Bound the in-code deadline below this so we always return cleanly. 60s is the
// Vercel Hobby cap.
export const maxDuration = 60

/**
 * Self-heal for WooCommerce webhooks that Woo auto-DISABLED after failed
 * deliveries. Lists each active store's webhooks and flips any of OUR disabled
 * ones back to active, so sync resumes without anyone toggling it by hand.
 * Driven by a Vercel Cron (Authorization: Bearer CRON_SECRET) or a manual call
 * forwarding the worker secret (x-wms-worker-key / ?key=).
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
    const summary = await reactivateWooWebhooks(admin, { deadlineMs: 50_000 })
    return NextResponse.json({ ok: true, ...summary }, { status: 200 })
  } catch (err) {
    const message = err instanceof Error ? err.message : "reactivate failed"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

// GET so a Vercel Cron (which issues GET) can drive it; POST for manual runs.
export const GET = handle
export const POST = handle
