import type { SupabaseClient } from "@supabase/supabase-js"

import { createAdminClient } from "@/lib/supabase/admin"

/**
 * Outbound ORDER fulfillment sync (WMS -> store).
 *
 * Companion to the outbound inventory sync (lib/store-sync/outbound.ts). The DB
 * side (migration 0047) is the durable source of truth: a trigger on `shipments`
 * enqueues one coalesced job per store-mapped order in the group when a shipment
 * is marked SHIPPED. This module DRAINS that queue: it claims due jobs atomically
 * (claim_outbound_order_jobs, FOR UPDATE SKIP LOCKED), pushes a fulfillment (with
 * the shipment's tracking) to the store API, then records the outcome
 * (complete_outbound_order_job) — success, a permanent skip, or a failure that
 * retries with exponential backoff and gives up after a cap.
 *
 * Everything runs with the SERVICE ROLE: the claim/complete RPCs are sealed to
 * service_role and the queue table is RLS-locked. Pushes are best-effort and
 * idempotent-ish: Shopify rejects a second fulfillment of an already-fulfilled
 * order (treated as a permanent skip) and Woo 'completed' is a no-op if already
 * completed, so an at-least-once retry never double-notifies the customer.
 *
 * Channels: Shopify and WooCommerce are both wired. Any future channel parks
 * visibly in the queue (skipped, with a clear reason) rather than silently
 * dropping the fulfillment.
 */

const SHOPIFY_API_VERSION = "2024-10"
/** Polite spacing between store API calls. */
const PUSH_GAP_MS = 300
/** Push the store's customer-facing shipping-confirmation email (product decision). */
const NOTIFY_CUSTOMER = true

export type OrderDrainSummary = {
  claimed: number
  pushed: number
  skipped: number
  failed: number
  firstError?: string
}

type ClaimedOrderJob = {
  job_id: string
  order_id: string
  site_id: string
  attempts: number
  channel: string | null
  source: string | null
  external_order_id: string | null
  tracking_number: string | null
  tracking_company: string | null
}

/** Outcome of a single push attempt. */
type PushOutcome =
  | { ok: true }
  | { ok: false; skip: true; error: string } // won't be fixed by retrying
  | { ok: false; skip: false; error: string } // transient; retry with backoff

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Claim and process up to `limit` due jobs. Safe to run concurrently (claims
 * use SKIP LOCKED) and safe to call repeatedly.
 */
export async function drainOutboundOrders(
  admin: SupabaseClient,
  opts: { limit?: number } = {},
): Promise<OrderDrainSummary> {
  const limit = opts.limit ?? 50
  const summary: OrderDrainSummary = { claimed: 0, pushed: 0, skipped: 0, failed: 0 }

  const { data, error } = await admin.rpc("claim_outbound_order_jobs", {
    p_limit: limit,
  })
  if (error) {
    summary.firstError = error.message
    return summary
  }
  const jobs = (data ?? []) as ClaimedOrderJob[]
  summary.claimed = jobs.length
  if (jobs.length === 0) return summary

  // Resolve credentials once per source. Shopify: an access token; Woo: a
  // consumer key/secret pair.
  const tokenBySource = new Map<string, string | null>()
  const wooCredsBySource = new Map<string, WooCreds | null>()

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i]
    const outcome = await pushJob(admin, job, tokenBySource, wooCredsBySource)

    if (outcome.ok) {
      summary.pushed++
      await complete(admin, job.job_id, { ok: true })
    } else if (outcome.skip) {
      summary.skipped++
      await complete(admin, job.job_id, { ok: false, skip: true, error: outcome.error })
    } else {
      summary.failed++
      if (!summary.firstError) summary.firstError = outcome.error
      await complete(admin, job.job_id, { ok: false, skip: false, error: outcome.error })
    }

    // Space out real API calls; skips (no network) don't need the gap.
    if (outcome.ok || !outcome.skip) {
      if (i < jobs.length - 1) await sleep(PUSH_GAP_MS)
    }
  }

  return summary
}

async function pushJob(
  admin: SupabaseClient,
  job: ClaimedOrderJob,
  tokenBySource: Map<string, string | null>,
  wooCredsBySource: Map<string, WooCreds | null>,
): Promise<PushOutcome> {
  if (!job.channel || !job.source) {
    return { ok: false, skip: true, error: "No active outbound connection for this order." }
  }
  if (!job.external_order_id) {
    return {
      ok: false,
      skip: true,
      error: "Order has no store id mapping — was it imported from this store?",
    }
  }
  if (job.channel === "shopify") return pushShopify(admin, job, tokenBySource)
  if (job.channel === "woocommerce") return pushWoo(admin, job, wooCredsBySource)
  return {
    ok: false,
    skip: true,
    error: `Outbound fulfillment for channel '${job.channel}' is not implemented yet.`,
  }
}

// ---------------------------------------------------------------------------
// Shopify adapter — create a fulfillment against the order's open fulfillment
// orders (2024-10 fulfillment-orders API), attaching tracking + notifying.
// ---------------------------------------------------------------------------
async function pushShopify(
  admin: SupabaseClient,
  job: ClaimedOrderJob,
  tokenBySource: Map<string, string | null>,
): Promise<PushOutcome> {
  const source = job.source as string
  const orderId = job.external_order_id as string

  const token = await resolveShopifyToken(admin, source, tokenBySource)
  if (!token) {
    // Transient from the queue's POV: once the token is set, a retry succeeds.
    return { ok: false, skip: false, error: "Store access token not set." }
  }

  const base = `https://${source}/admin/api/${SHOPIFY_API_VERSION}`
  const auth = { "X-Shopify-Access-Token": token, "Content-Type": "application/json" }

  // 1. Which fulfillment orders can still be fulfilled?
  let foIds: number[]
  try {
    const r = await fetch(`${base}/orders/${orderId}/fulfillment_orders.json`, {
      headers: auth,
      signal: AbortSignal.timeout(10_000),
    })
    if (r.status === 404) {
      return { ok: false, skip: true, error: "Shopify order not found (deleted?)." }
    }
    if (!r.ok) {
      const body = await r.text().catch(() => "")
      const msg = `Shopify ${r.status} (fulfillment_orders): ${body.slice(0, 200)}`
      // 401/403/429/5xx are transient or fixable.
      return { ok: false, skip: false, error: msg }
    }
    const body = (await r.json()) as {
      fulfillment_orders?: { id: number; status: string }[]
    }
    foIds = (body.fulfillment_orders ?? [])
      .filter((fo) => ["open", "in_progress", "scheduled"].includes(fo.status))
      .map((fo) => fo.id)
  } catch (e) {
    const msg = e instanceof Error ? e.message : "network error"
    return { ok: false, skip: false, error: `Could not reach Shopify: ${msg}` }
  }

  if (foIds.length === 0) {
    // Nothing left to fulfill — already fulfilled on the store side, or the
    // order isn't fulfillable. Either way retrying won't change it.
    return { ok: false, skip: true, error: "No open fulfillment orders (already fulfilled?)." }
  }

  // 2. Create the fulfillment for those fulfillment orders, with tracking.
  const fulfillment: Record<string, unknown> = {
    line_items_by_fulfillment_order: foIds.map((id) => ({ fulfillment_order_id: id })),
    notify_customer: NOTIFY_CUSTOMER,
  }
  if (job.tracking_number || job.tracking_company) {
    fulfillment.tracking_info = {
      number: job.tracking_number ?? null,
      company: job.tracking_company ?? null,
    }
  }

  try {
    const r = await fetch(`${base}/fulfillments.json`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ fulfillment }),
      signal: AbortSignal.timeout(10_000),
    })
    if (r.ok) return { ok: true }

    const body = await r.text().catch(() => "")
    const msg = `Shopify ${r.status} (fulfillments): ${body.slice(0, 300)}`
    // 422 = already fulfilled / not fulfillable; 404 = gone. Won't fix by retry.
    if (r.status === 404 || r.status === 422) {
      return { ok: false, skip: true, error: msg }
    }
    return { ok: false, skip: false, error: msg }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "network error"
    return { ok: false, skip: false, error: `Could not reach Shopify: ${msg}` }
  }
}

async function resolveShopifyToken(
  admin: SupabaseClient,
  source: string,
  tokenBySource: Map<string, string | null>,
): Promise<string | null> {
  const cached = tokenBySource.get(source)
  if (cached !== undefined) return cached
  const { data: secret } = await admin
    .from("store_secrets")
    .select("access_token, store_connections!inner(channel, source)")
    .eq("store_connections.channel", "shopify")
    .eq("store_connections.source", source)
    .maybeSingle()
  const token = (secret?.access_token as string | undefined) ?? null
  tokenBySource.set(source, token)
  return token
}

// ---------------------------------------------------------------------------
// WooCommerce adapter — mark the order 'completed' (Woo emails the customer the
// completed-order notification) and attach tracking as a customer-facing note.
// Woo core has no fulfillment object, so 'completed' is the fulfillment signal.
// ---------------------------------------------------------------------------
type WooCreds = { key: string; secret: string }

async function pushWoo(
  admin: SupabaseClient,
  job: ClaimedOrderJob,
  credsBySource: Map<string, WooCreds | null>,
): Promise<PushOutcome> {
  const source = job.source as string
  const orderId = job.external_order_id as string

  let creds = credsBySource.get(source)
  if (creds === undefined) {
    const { data } = await admin
      .from("store_secrets")
      .select("consumer_key, consumer_secret, store_connections!inner(channel, source)")
      .eq("store_connections.channel", "woocommerce")
      .eq("store_connections.source", source)
      .maybeSingle()
    creds =
      data?.consumer_key && data?.consumer_secret
        ? { key: data.consumer_key as string, secret: data.consumer_secret as string }
        : null
    credsBySource.set(source, creds)
  }
  if (!creds) {
    // Transient from the queue's POV: once creds are set, a retry succeeds.
    return { ok: false, skip: false, error: "Store API credentials not set." }
  }

  const origin = source.replace(/\/+$/, "")
  const auth = "Basic " + Buffer.from(`${creds.key}:${creds.secret}`).toString("base64")

  // 1. Mark the order completed (the fulfillment signal in Woo).
  try {
    const r = await fetch(`${origin}/wp-json/wc/v3/orders/${orderId}`, {
      method: "PUT",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "completed" }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!r.ok) {
      const body = await r.text().catch(() => "")
      const msg = `WooCommerce ${r.status} (order): ${body.slice(0, 300)}`
      // 400/404 mean the order id is wrong / gone — retrying won't help.
      if (r.status === 400 || r.status === 404) {
        return { ok: false, skip: true, error: msg }
      }
      return { ok: false, skip: false, error: msg }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "network error"
    return { ok: false, skip: false, error: `Could not reach WooCommerce: ${msg}` }
  }

  // 2. Attach tracking as a customer-facing note (best effort — the order is
  //    already completed, so a note failure must not fail/retry the job).
  if (NOTIFY_CUSTOMER && (job.tracking_number || job.tracking_company)) {
    const parts = [
      job.tracking_company ? `Shipped via ${job.tracking_company}.` : "Shipped.",
      job.tracking_number ? `Tracking: ${job.tracking_number}` : "",
    ].filter(Boolean)
    try {
      await fetch(`${origin}/wp-json/wc/v3/orders/${orderId}/notes`, {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/json" },
        body: JSON.stringify({ note: parts.join(" "), customer_note: true }),
        signal: AbortSignal.timeout(10_000),
      })
    } catch {
      // ignore — completion already succeeded
    }
  }

  return { ok: true }
}

// ---------------------------------------------------------------------------
async function complete(
  admin: SupabaseClient,
  jobId: string,
  outcome: { ok: true } | { ok: false; skip: boolean; error: string },
): Promise<void> {
  await admin.rpc("complete_outbound_order_job", {
    p_job_id: jobId,
    p_ok: outcome.ok,
    p_error: outcome.ok ? null : outcome.error,
    p_skip: outcome.ok ? false : outcome.skip,
  })
}

/**
 * Fire-and-forget immediate drain after a shipment is marked shipped. Bounded and
 * fully swallows errors — the durable queue + the scheduled drain are the safety
 * net, so a kick that fails (or a missing service-role key in dev) must never
 * surface to the user or break the originating action.
 */
export async function kickOutboundOrderDrain(limit = 50): Promise<void> {
  try {
    const admin = createAdminClient()
    await drainOutboundOrders(admin, { limit })
  } catch {
    // Intentionally ignored: the scheduled drain will pick up pending jobs.
  }
}
