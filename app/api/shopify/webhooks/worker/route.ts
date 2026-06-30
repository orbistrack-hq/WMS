import { NextResponse } from "next/server"

import { createAdminClient } from "@/lib/supabase/admin"
import { processShopifyEvent } from "@/lib/shopify/process-event"
import { verifyWorkerSecret, type StoreEventJob } from "@/lib/store-sync/queue"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * QStash worker for Shopify events. QStash POSTs the job here (with safe
 * retries) after the webhook route enqueued it. The delivery was already
 * HMAC-verified at the edge before enqueue, so this route authenticates via the
 * forwarded worker secret and runs the shared processor.
 *
 * Returns 500 on failure so QStash retries with backoff; durable idempotency
 * (store_order_imports unique key + guarded RPCs) makes the retry safe.
 */
export async function POST(req: Request) {
  if (!verifyWorkerSecret(req.headers.get("x-wms-worker-key"))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  }

  let job: StoreEventJob
  try {
    job = (await req.json()) as StoreEventJob
  } catch {
    return NextResponse.json({ error: "invalid job" }, { status: 400 })
  }

  const supabase = createAdminClient()
  try {
    const result = await processShopifyEvent(
      supabase,
      job.topic,
      job.source,
      job.payload,
    )
    return NextResponse.json({ ok: true, ...result }, { status: 200 })
  } catch (err) {
    const message = err instanceof Error ? err.message : "processing failed"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
