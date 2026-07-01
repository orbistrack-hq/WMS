import crypto from "node:crypto"
import { NextResponse } from "next/server"

import { createAdminClient } from "@/lib/supabase/admin"
import { normalizeWooSource, verifyWooSignature } from "@/lib/woocommerce/types"
import { processWooEvent } from "@/lib/woocommerce/process-event"
import { kickOutboundDrain } from "@/lib/store-sync/outbound"
import {
  dedupeKey,
  publishToQueue,
  queueEnabled,
  redisDedupe,
  type StoreEventJob,
} from "@/lib/store-sync/queue"

// HMAC verification + the service-role client need the Node runtime.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * WooCommerce webhook receiver. Fast path only: authenticate (signature),
 * dedupe, then hand off to the QStash queue, or process inline when no queue is
 * configured. All heavy DB work lives in processWooEvent(), shared with the
 * worker route.
 *
 * Dedupe id: Woo gives every RETRY a new delivery id, so a delivery id can't
 * dedupe retries. Instead we key on a hash of the raw body — identical
 * re-deliveries hash the same (deduped), while a genuinely different update
 * hashes differently (processed). Durable correctness still rests on the DB.
 */
export async function POST(req: Request) {
  const raw = await req.text()
  const signature = req.headers.get("x-wc-webhook-signature")
  const topic = req.headers.get("x-wc-webhook-topic") ?? ""
  const source = normalizeWooSource(req.headers.get("x-wc-webhook-source") ?? "")

  const supabase = createAdminClient()

  // Authenticate per-store: verify the signature against THIS store's own
  // webhook secret (entered by the client). Falls back to a global env secret.
  const { data: connRow } = await supabase
    .from("store_connections")
    .select("secret:store_secrets(webhook_secret)")
    .eq("channel", "woocommerce")
    .eq("source", source)
    .eq("is_active", true)
    .maybeSingle()
  const embed = (connRow as { secret?: unknown } | null)?.secret
  const storeSecret = (Array.isArray(embed) ? embed[0] : embed) as
    | { webhook_secret?: string | null }
    | null
    | undefined
  const secret =
    storeSecret?.webhook_secret ?? process.env.WOOCOMMERCE_WEBHOOK_SECRET

  if (!verifyWooSignature(raw, signature, secret ?? undefined)) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 })
  }

  // Woo sends a non-JSON ping ("webhook_id=...") when a webhook is first saved.
  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    return NextResponse.json({ ok: true, ignored: "non-json ping" })
  }

  const bodyHash = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 32)
  const job: StoreEventJob = {
    channel: "woocommerce",
    source,
    topic,
    webhookId: bodyHash,
    payload,
  }

  // 1) Fast-path dedupe of identical re-deliveries.
  if ((await redisDedupe(dedupeKey(job))) === "seen") {
    return NextResponse.json({ ok: true, duplicate: true }, { status: 200 })
  }

  // 2) Enqueue for async processing when the queue is configured.
  if (queueEnabled() && (await publishToQueue(job))) {
    return NextResponse.json({ ok: true, queued: true }, { status: 200 })
  }

  // 3) Fallback: process inline (local dev / Upstash not yet provisioned).
  try {
    const result = await processWooEvent(supabase, topic, source, payload)
    await kickOutboundDrain()
    return NextResponse.json({ ok: true, ...result }, { status: 200 })
  } catch (err) {
    const message = err instanceof Error ? err.message : "processing failed"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
