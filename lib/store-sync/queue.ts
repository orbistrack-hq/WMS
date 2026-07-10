/**
 * Store-sync queue + dedupe layer.
 *
 * The webhook routes must answer the platform FAST (verify -> ack) and do the
 * heavy DB work asynchronously, otherwise a slow Supabase call makes Shopify /
 * Woo think delivery failed and they retry — which is exactly how stock gets
 * double-counted. This module provides:
 *
 *   1. publishToQueue() — hand the event to Upstash QStash, which POSTs it to
 *      our worker route with safe retries and built-in publish dedupe.
 *   2. redisDedupe()    — a best-effort fast-path dedupe in Upstash Redis so a
 *      burst of identical re-deliveries doesn't even reach the worker.
 *   3. verifyWorkerSecret() — auth for the worker route.
 *
 * EVERYTHING here is dependency-free (plain fetch against the Upstash REST APIs)
 * and degrades gracefully: when the Upstash env vars are absent, queueEnabled()
 * is false and the caller processes the event inline. So local dev and a
 * not-yet-provisioned Upstash both "just work" — they're simply synchronous.
 *
 * Durable, money-critical idempotency does NOT live here. It lives in the DB:
 * store_order_imports has a unique (channel, source, external_order_id) key, and
 * fulfill_order / cancel_order are guarded. Redis/QStash dedupe is an
 * optimization in front of that guarantee, never a replacement for it.
 */

export type StoreChannel = "shopify" | "woocommerce"

export type StoreEventJob = {
  channel: StoreChannel
  /** Shop domain (Shopify) or canonical store URL (Woo) — the connection key. */
  source: string
  /** Platform topic, e.g. "orders/create" or "order.updated". */
  topic: string
  /** Platform delivery/event id, used as the QStash dedupe id when present. */
  webhookId: string | null
  /** The already-parsed webhook body. */
  payload: unknown
}

// ---------------------------------------------------------------------------
// Env / config
// ---------------------------------------------------------------------------
const QSTASH_URL =
  process.env.QSTASH_URL?.replace(/\/+$/, "") ?? "https://qstash.upstash.io"
const QSTASH_TOKEN = process.env.QSTASH_TOKEN
/**
 * Publicly reachable base URL of THIS deployment, e.g.
 * "https://wms.vercel.app". QStash must be able to POST back to our worker, so
 * this has to be a real public origin — never localhost. On Vercel set it to
 * the production URL; leaving it unset disables the queue (inline fallback).
 */
const PUBLIC_BASE_URL = process.env.STORE_SYNC_PUBLIC_URL?.replace(/\/+$/, "")
/** Shared secret the worker route checks (forwarded by QStash). */
const WORKER_SECRET = process.env.STORE_SYNC_WORKER_SECRET

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL?.replace(/\/+$/, "")
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN

/** True when PUBLIC_BASE_URL is a parseable absolute URL (needs a scheme). */
function publicBaseUrlValid(): boolean {
  if (!PUBLIC_BASE_URL) return false
  try {
    new URL(PUBLIC_BASE_URL)
    return true
  } catch {
    return false
  }
}

/**
 * True when QStash is configured AND we have a VALID public URL it can call
 * back. The URL must parse (i.e. include a scheme like https://) — a bare host
 * such as "app.vercel.app" would otherwise pass the truthy check, then make
 * publishToQueue build a malformed target that QStash rejects, silently
 * dropping us to inline processing. Validating here fails honestly instead.
 */
export function queueEnabled(): boolean {
  return Boolean(QSTASH_TOKEN && WORKER_SECRET) && publicBaseUrlValid()
}

/** True when an Upstash Redis REST endpoint is configured for fast dedupe. */
export function redisEnabled(): boolean {
  return Boolean(REDIS_URL && REDIS_TOKEN)
}

// ---------------------------------------------------------------------------
// Redis fast-path dedupe (best effort)
// ---------------------------------------------------------------------------
/**
 * Atomically claim a dedupe key: SET key 1 NX EX <ttl>. Returns:
 *   "new"     — first time we've seen this key (proceed)
 *   "seen"    — already claimed within the TTL (skip)
 *   "unknown" — Redis not configured or unreachable (caller must NOT skip;
 *               fall through to the durable DB idempotency instead)
 *
 * Never throws — a Redis hiccup must not drop a webhook.
 */
export async function redisDedupe(
  key: string,
  ttlSeconds = 86_400,
): Promise<"new" | "seen" | "unknown"> {
  if (!redisEnabled()) return "unknown"
  try {
    // Upstash REST: /set/<key>/<value>?NX=true&EX=<ttl>
    const url = `${REDIS_URL}/set/${encodeURIComponent(
      key,
    )}/1?NX=true&EX=${ttlSeconds}`
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
      // Keep this snappy; it sits on the request hot path.
      signal: AbortSignal.timeout(2_000),
    })
    if (!res.ok) return "unknown"
    const body = (await res.json()) as { result: string | null }
    // SET NX returns "OK" when it set the key, null when it already existed.
    return body.result === "OK" ? "new" : "seen"
  } catch {
    return "unknown"
  }
}

/** Build a stable dedupe key for an event. */
export function dedupeKey(job: Pick<StoreEventJob, "channel" | "source" | "webhookId" | "topic">): string {
  const id = job.webhookId ?? "no-id"
  return `wh:${job.channel}:${job.source}:${job.topic}:${id}`
}

// ---------------------------------------------------------------------------
// QStash publish
// ---------------------------------------------------------------------------
/**
 * Publish an event to QStash for async processing by the worker route. Returns
 * true on success; false means the caller should process inline as a fallback.
 * Never throws.
 *
 * QStash gives us: at-least-once delivery with exponential-backoff retries, and
 * publish-level dedupe via Upstash-Deduplication-Id (so a double-publish of the
 * same delivery within the window collapses to one). The worker is authenticated
 * by the forwarded x-wms-worker-key header.
 */
export async function publishToQueue(job: StoreEventJob): Promise<boolean> {
  if (!queueEnabled()) return false
  const target = `${PUBLIC_BASE_URL}/api/${job.channel}/webhooks/worker`
  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${QSTASH_TOKEN}`,
      "Content-Type": "application/json",
      // QStash forwards Upstash-Forward-* headers to the destination, stripped
      // of the prefix — the worker sees plain "x-wms-worker-key".
      "Upstash-Forward-x-wms-worker-key": WORKER_SECRET as string,
      // Cap retries so a permanently-bad event doesn't loop forever; it lands in
      // the QStash DLQ for inspection after this many attempts.
      "Upstash-Retries": "5",
    }
    if (job.webhookId) {
      headers["Upstash-Deduplication-Id"] = dedupeKey(job)
    }
    const res = await fetch(`${QSTASH_URL}/v2/publish/${target}`, {
      method: "POST",
      headers,
      body: JSON.stringify(job),
      signal: AbortSignal.timeout(3_000),
    })
    return res.ok
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Worker auth
// ---------------------------------------------------------------------------
/**
 * Verify the worker-secret header that QStash forwards. Constant-time-ish equal.
 * Returns false when the secret is unset (fail closed) so a misconfigured worker
 * can never run unauthenticated.
 */
export function verifyWorkerSecret(headerValue: string | null): boolean {
  if (!WORKER_SECRET || !headerValue) return false
  if (headerValue.length !== WORKER_SECRET.length) return false
  let diff = 0
  for (let i = 0; i < headerValue.length; i++) {
    diff |= headerValue.charCodeAt(i) ^ WORKER_SECRET.charCodeAt(i)
  }
  return diff === 0
}
