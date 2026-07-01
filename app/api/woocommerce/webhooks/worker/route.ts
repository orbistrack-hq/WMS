import { NextResponse } from "next/server"

import { createAdminClient } from "@/lib/supabase/admin"
import { processWooEvent } from "@/lib/woocommerce/process-event"
import { kickOutboundDrain } from "@/lib/store-sync/outbound"
import { verifyWorkerSecret, type StoreEventJob } from "@/lib/store-sync/queue"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * QStash worker for WooCommerce events. QStash POSTs the job here (with safe
 * retries) after the webhook route enqueued it. The delivery was already
 * signature-verified at the edge before enqueue, so this route authenticates
 * via the forwarded worker secret and runs the shared processor.
 *
 * Returns 500 on failure so QStash retries with backoff; durable idempotency
 * makes the retry safe.
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
    const result = await processWooEvent(
      supabase,
      job.topic,
      job.source,
      job.payload,
    )
    await kickOutboundDrain()
    return NextResponse.json({ ok: true, ...result }, { status: 200 })
  } catch (err) {
    const message = err instanceof Error ? err.message : "processing failed"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
