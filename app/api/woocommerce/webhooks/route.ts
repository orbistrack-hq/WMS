import crypto from "node:crypto"
import { NextResponse } from "next/server"

import { createAdminClient } from "@/lib/supabase/admin"
import { normalizeWooSource, verifyWooSignature } from "@/lib/woocommerce/types"
import { processWooEvent } from "@/lib/woocommerce/process-event"
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

  // WooCommerce sends a non-JSON connectivity ping ("webhook_id=...") when a
  // webhook is saved or activated. It carries no order data and is NOT signed,
  // so acknowledge it BEFORE signature verification — otherwise it 401s and Woo
  // treats the delivery URL as failing, which is what silently disables the
  // webhook. Real deliveries are JSON and signed; those fall through to auth.
  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    return NextResponse.json({ ok: true, ignored: "non-json ping" })
  }

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
    // Diagnostic (no secret values): tells you WHY the 401 happened —
    // "connMatched:false" => the incoming source doesn't match any active
    // store_connections.source (fix the stored source); "secretSource:none"
    // => neither a per-store nor an env secret exists; "secretSource:per-store"
    // with connMatched:true => the stored secret value doesn't match the store.
    console.warn("[woo-webhook] 401 invalid signature", {
      source,
      connMatched: Boolean(connRow),
      secretSource: storeSecret?.webhook_secret
        ? "per-store"
        : process.env.WOOCOMMERCE_WEBHOOK_SECRET
          ? "env"
          : "none",
      signaturePresent: Boolean(signature),
      topic,
    })
    return NextResponse.json({ error: "invalid signature" }, { status: 401 })
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
  //    We deliberately DO NOT drain the outbound inventory queue here. Draining
  //    makes network calls to the store and can run long; doing it on the ack
  //    path is what let a slow/backed-up store delay this 200 until WooCommerce
  //    marked deliveries failed and DISABLED the webhook. Outbound flushes via
  //    the scheduled drain (/api/store-sync/outbound) and kicks from WMS server
  //    actions instead — off the delivery path.
  try {
    const result = await processWooEvent(supabase, topic, source, payload)
    return NextResponse.json({ ok: true, ...result }, { status: 200 })
  } catch (err) {
    const message = err instanceof Error ? err.message : "processing failed"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
