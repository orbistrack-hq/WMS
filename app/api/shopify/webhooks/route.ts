import { NextResponse } from "next/server"

import { createAdminClient } from "@/lib/supabase/admin"
import { verifyShopifyHmac } from "@/lib/shopify/types"
import { processShopifyEvent } from "@/lib/shopify/process-event"
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
 * Shopify webhook receiver. Fast path only: authenticate the delivery (HMAC),
 * dedupe, then hand off — either to the QStash queue (production) or, when no
 * queue is configured, process inline as a fallback. All heavy DB work lives in
 * processShopifyEvent(), shared with the worker route so both behave the same.
 *
 * Durable idempotency is in the DB (store_order_imports unique key + guarded
 * RPCs); the Redis/QStash dedupe here is a fast-path optimization on top.
 */
export async function POST(req: Request) {
  const raw = await req.text()
  const hmac = req.headers.get("x-shopify-hmac-sha256")
  const topic = req.headers.get("x-shopify-topic") ?? ""
  const shopDomain = req.headers.get("x-shopify-shop-domain") ?? ""
  const webhookId = req.headers.get("x-shopify-webhook-id")

  const supabase = createAdminClient()

  // Authenticate per-store: verify the HMAC against THIS store's own API secret
  // (entered by the client). Falls back to a global env secret if one is set.
  const { data: connRow } = await supabase
    .from("store_connections")
    .select("secret:store_secrets(api_secret)")
    .eq("channel", "shopify")
    .eq("source", shopDomain)
    .eq("is_active", true)
    .maybeSingle()
  const embed = (connRow as { secret?: unknown } | null)?.secret
  const storeSecret = (Array.isArray(embed) ? embed[0] : embed) as
    | { api_secret?: string | null }
    | null
    | undefined
  const secret = storeSecret?.api_secret ?? process.env.SHOPIFY_WEBHOOK_SECRET

  if (!verifyShopifyHmac(raw, hmac, secret ?? undefined)) {
    // Diagnostic (no secret values): tells you WHY the 401 happened —
    // "connMatched:false" => the incoming shop domain doesn't match any active
    // store_connections.source (fix the stored source; it must be the bare
    // *.myshopify.com domain, no scheme); "secretSource:none" => no api_secret
    // on the connection and no env fallback; "secretSource:per-store" with
    // connMatched:true => the stored api_secret doesn't match the app's secret.
    console.warn("[shopify-webhook] 401 invalid hmac", {
      shopDomain,
      connMatched: Boolean(connRow),
      secretSource: storeSecret?.api_secret
        ? "per-store"
        : process.env.SHOPIFY_WEBHOOK_SECRET
          ? "env"
          : "none",
      hmacPresent: Boolean(hmac),
      topic,
    })
    return NextResponse.json({ error: "invalid hmac" }, { status: 401 })
  }

  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 })
  }

  const job: StoreEventJob = {
    channel: "shopify",
    source: shopDomain,
    topic,
    webhookId,
    payload,
  }

  // 1) Fast-path dedupe: collapse a burst of identical re-deliveries before
  //    they touch the DB. "unknown" (Redis off) falls through to durable dedupe.
  if ((await redisDedupe(dedupeKey(job))) === "seen") {
    return NextResponse.json({ ok: true, duplicate: true }, { status: 200 })
  }

  // 2) Enqueue for async processing when the queue is configured.
  if (queueEnabled() && (await publishToQueue(job))) {
    return NextResponse.json({ ok: true, queued: true }, { status: 200 })
  }

  // 3) Fallback: process inline (local dev / Upstash not yet provisioned).
  //    Do NOT drain the outbound inventory queue on this ack path — a slow store
  //    would delay the 200 and can get the webhook disabled by the platform (see
  //    the WooCommerce receiver). Outbound flushes via the scheduled drain
  //    (/api/store-sync/outbound) and kicks from WMS server actions.
  try {
    const result = await processShopifyEvent(supabase, topic, shopDomain, payload)
    return NextResponse.json({ ok: true, ...result }, { status: 200 })
  } catch (err) {
    // Return 500 so Shopify retries; durable idempotency makes the retry safe.
    const message = err instanceof Error ? err.message : "processing failed"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
