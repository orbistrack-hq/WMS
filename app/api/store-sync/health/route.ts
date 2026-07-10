import { NextResponse } from "next/server"

import { queueEnabled, redisEnabled } from "@/lib/store-sync/queue"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Secret-safe store-sync diagnostic.
 *
 * Reports WHICH store-sync env vars the RUNNING production deployment can
 * actually see — as booleans only, never any values — so you can confirm
 * queueEnabled()/redisEnabled() without guessing at Vercel's env state.
 *
 *   GET /api/store-sync/health
 *
 * queueEnabled requires QSTASH_TOKEN + STORE_SYNC_PUBLIC_URL +
 * STORE_SYNC_WORKER_SECRET to ALL be present. If it's false, the `vars` map
 * shows exactly which one is missing. Redis dedupe is independent (its own two
 * vars), so redisEnabled can be true while queueEnabled is false — which is
 * likely your current state.
 *
 * publicUrlHost is echoed back (a public URL, not a secret) so you can confirm
 * it points at the same origin the stores POST to.
 */
export async function GET() {
  const publicUrl = process.env.STORE_SYNC_PUBLIC_URL?.replace(/\/+$/, "") ?? null
  let publicUrlHost: string | null = null
  try {
    if (publicUrl) publicUrlHost = new URL(publicUrl).host
  } catch {
    publicUrlHost = "INVALID_URL"
  }

  return NextResponse.json({
    queueEnabled: queueEnabled(),
    redisEnabled: redisEnabled(),
    // Presence only — never the values.
    vars: {
      QSTASH_TOKEN: Boolean(process.env.QSTASH_TOKEN),
      STORE_SYNC_PUBLIC_URL: Boolean(process.env.STORE_SYNC_PUBLIC_URL),
      STORE_SYNC_WORKER_SECRET: Boolean(process.env.STORE_SYNC_WORKER_SECRET),
      UPSTASH_REDIS_REST_URL: Boolean(process.env.UPSTASH_REDIS_REST_URL),
      UPSTASH_REDIS_REST_TOKEN: Boolean(process.env.UPSTASH_REDIS_REST_TOKEN),
      SHOPIFY_WEBHOOK_SECRET: Boolean(process.env.SHOPIFY_WEBHOOK_SECRET),
      WOOCOMMERCE_WEBHOOK_SECRET: Boolean(process.env.WOOCOMMERCE_WEBHOOK_SECRET),
    },
    publicUrlHost,
  })
}
