import type { SupabaseClient } from "@supabase/supabase-js"

import { createAdminClient } from "@/lib/supabase/admin"

/**
 * Outbound inventory sync (WMS -> store).
 *
 * The DB side (migration 0026) is the durable source of truth: a trigger on
 * inventory_ledger enqueues one coalesced job per child SKU into
 * store_outbound_inventory_jobs with the latest target `available`, skipping
 * store-originated movements (loop suppression). This module DRAINS that queue:
 * it claims due jobs atomically (claim_outbound_inventory_jobs, FOR UPDATE SKIP
 * LOCKED), pushes the target quantity to the store API, then records the outcome
 * (complete_outbound_inventory_job) — success, a permanent skip, or a failure
 * that retries with exponential backoff and gives up after a cap.
 *
 * Everything runs with the SERVICE ROLE: the claim/complete RPCs are sealed to
 * service_role and the queue table is RLS-locked. Pushes are best-effort and
 * idempotent (we SET an absolute available, never a delta), so a re-run or an
 * at-least-once retry can never corrupt store stock.
 *
 * Channels: Shopify and WooCommerce are both wired here. Any future channel
 * parks visibly in the queue (skipped, with a clear reason) rather than silently
 * dropping stock.
 *
 * TIME BUDGET: draining makes real network calls to the store, so it can run
 * long when the store is slow or the queue is deep. Callers on a latency-
 * sensitive path (esp. a webhook ack) MUST pass a `deadlineMs` so a slow store
 * can never delay them. Jobs that were claimed but not reached before the
 * deadline stay in 'processing' and are reset to 'pending' by the reaper
 * (reap_stuck_outbound_inventory_jobs), then retried on the next drain.
 */

const SHOPIFY_API_VERSION = "2024-10"
/** Polite spacing between store API calls (Shopify REST allows ~2 req/s). */
const PUSH_GAP_MS = 300

export type DrainSummary = {
  claimed: number
  pushed: number
  skipped: number
  failed: number
  /** True when we stopped early because the time budget (deadlineMs) elapsed. */
  deadlineHit?: boolean
  firstError?: string
}

type ClaimedJob = {
  job_id: string
  child_sku_id: string
  site_id: string
  desired_available: number
  attempts: number
  channel: string | null
  source: string | null
  store_variant_id: string | null
  store_inventory_item_id: string | null
  store_parent_id: string | null
  inventory_location_id: string | null
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
 *
 * `deadlineMs` (optional) is an overall wall-clock budget: once it elapses we
 * stop before claiming/processing further jobs and return what we've done so
 * far. Any already-claimed-but-unprocessed job is left 'processing' for the
 * reaper to recover — this is what stops a slow store from blocking the caller.
 */
export async function drainOutboundInventory(
  admin: SupabaseClient,
  opts: { limit?: number; deadlineMs?: number } = {},
): Promise<DrainSummary> {
  const limit = opts.limit ?? 50
  const deadline =
    opts.deadlineMs && opts.deadlineMs > 0 ? Date.now() + opts.deadlineMs : Infinity
  const summary: DrainSummary = { claimed: 0, pushed: 0, skipped: 0, failed: 0 }

  const { data, error } = await admin.rpc("claim_outbound_inventory_jobs", {
    p_limit: limit,
  })
  if (error) {
    summary.firstError = error.message
    return summary
  }
  const jobs = (data ?? []) as ClaimedJob[]
  summary.claimed = jobs.length
  if (jobs.length === 0) return summary

  // Resolve credentials once per source (avoid re-reading the sealed secrets
  // table for every job of the same store). Shopify: an access token; Woo: a
  // consumer key/secret pair.
  const tokenBySource = new Map<string, string | null>()
  const wooCredsBySource = new Map<string, WooCreds | null>()

  for (let i = 0; i < jobs.length; i++) {
    // Time budget: bail before touching the next job once the deadline passes.
    // Remaining claimed jobs stay 'processing'; the reaper resets them to
    // 'pending' and the next drain retries them.
    if (Date.now() >= deadline) {
      summary.deadlineHit = true
      break
    }

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
  job: ClaimedJob,
  tokenBySource: Map<string, string | null>,
  wooCredsBySource: Map<string, WooCreds | null>,
): Promise<PushOutcome> {
  if (!job.channel || !job.source) {
    return { ok: false, skip: true, error: "No active outbound connection for this site." }
  }
  if (job.channel === "shopify") return pushShopify(admin, job, tokenBySource)
  if (job.channel === "woocommerce") return pushWoo(admin, job, wooCredsBySource)
  return {
    ok: false,
    skip: true,
    error: `Outbound push for channel '${job.channel}' is not implemented yet.`,
  }
}

// ---------------------------------------------------------------------------
// Shopify adapter — set absolute available at the connection's location.
// ---------------------------------------------------------------------------
async function pushShopify(
  admin: SupabaseClient,
  job: ClaimedJob,
  tokenBySource: Map<string, string | null>,
): Promise<PushOutcome> {
  const source = job.source as string

  if (!job.store_inventory_item_id) {
    return {
      ok: false,
      skip: true,
      error: "Missing Shopify inventory_item_id — re-sync products to map it.",
    }
  }
  if (!job.inventory_location_id) {
    return {
      ok: false,
      skip: true,
      error: "No Shopify location set on the connection — re-sync products.",
    }
  }

  let token = tokenBySource.get(source)
  if (token === undefined) {
    const { data: secret } = await admin
      .from("store_secrets")
      .select("access_token, store_connections!inner(channel, source)")
      .eq("store_connections.channel", "shopify")
      .eq("store_connections.source", source)
      .maybeSingle()
    token = (secret?.access_token as string | undefined) ?? null
    tokenBySource.set(source, token)
  }
  if (!token) {
    // Transient from the queue's POV: once the token is set, a retry succeeds.
    return { ok: false, skip: false, error: "Store access token not set." }
  }

  const url = `https://${source}/admin/api/${SHOPIFY_API_VERSION}/inventory_levels/set.json`
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        location_id: Number(job.inventory_location_id),
        inventory_item_id: Number(job.store_inventory_item_id),
        available: job.desired_available,
      }),
      signal: AbortSignal.timeout(10_000),
    })

    if (r.ok) return { ok: true }

    const body = await r.text().catch(() => "")
    const msg = `Shopify ${r.status}: ${body.slice(0, 300)}`
    // 404/422 mean the item/location mapping is wrong — retrying won't help.
    if (r.status === 404 || r.status === 422) {
      return { ok: false, skip: true, error: msg }
    }
    // 429 / 5xx / auth: transient or fixable — retry with backoff.
    return { ok: false, skip: false, error: msg }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "network error"
    return { ok: false, skip: false, error: `Could not reach Shopify: ${msg}` }
  }
}

// ---------------------------------------------------------------------------
// WooCommerce adapter — set absolute stock_quantity on the product/variation.
// ---------------------------------------------------------------------------
type WooCreds = { key: string; secret: string }

async function pushWoo(
  admin: SupabaseClient,
  job: ClaimedJob,
  credsBySource: Map<string, WooCreds | null>,
): Promise<PushOutcome> {
  const source = job.source as string

  if (!job.store_variant_id) {
    return {
      ok: false,
      skip: true,
      error: "Missing WooCommerce product/variation id — re-sync products.",
    }
  }

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

  // Variable products are addressed via the parent; simple products directly.
  const path = job.store_parent_id
    ? `/products/${job.store_parent_id}/variations/${job.store_variant_id}`
    : `/products/${job.store_variant_id}`
  const url = `${source.replace(/\/+$/, "")}/wp-json/wc/v3${path}`
  const auth = "Basic " + Buffer.from(`${creds.key}:${creds.secret}`).toString("base64")

  try {
    const r = await fetch(url, {
      method: "PUT",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        manage_stock: true,
        stock_quantity: job.desired_available,
      }),
      signal: AbortSignal.timeout(10_000),
    })

    if (r.ok) return { ok: true }

    const body = await r.text().catch(() => "")
    const msg = `WooCommerce ${r.status}: ${body.slice(0, 300)}`
    // 400/404 mean the product/variation id is wrong — retrying won't help.
    if (r.status === 400 || r.status === 404) {
      return { ok: false, skip: true, error: msg }
    }
    // 429 / 5xx / auth: transient or fixable — retry with backoff.
    return { ok: false, skip: false, error: msg }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "network error"
    return { ok: false, skip: false, error: `Could not reach WooCommerce: ${msg}` }
  }
}

// ---------------------------------------------------------------------------
async function complete(
  admin: SupabaseClient,
  jobId: string,
  outcome:
    | { ok: true }
    | { ok: false; skip: boolean; error: string },
): Promise<void> {
  await admin.rpc("complete_outbound_inventory_job", {
    p_job_id: jobId,
    p_ok: outcome.ok,
    p_error: outcome.ok ? null : outcome.error,
    p_skip: outcome.ok ? false : outcome.skip,
  })
}

/**
 * Fire-and-forget immediate drain after a stock-changing action. TIME-BOUNDED
 * (never blocks the caller longer than ~deadlineMs) and fully swallows errors —
 * the scheduled drain + reaper are the safety net, so a kick that runs long,
 * fails, or hits a missing service-role key in dev must never surface to the
 * user or break the originating action.
 *
 * DO NOT call this on a webhook receiver's response path. Draining makes network
 * calls to the store; doing it before the ack is what let a slow/backed-up store
 * delay the 200 until WooCommerce marked deliveries failed and DISABLED the
 * webhook. Kicks belong on internal server actions and the QStash worker (off
 * the platform's delivery path). Webhook receivers just process + ack; outbound
 * flushes via the scheduled drain (/api/store-sync/outbound).
 */
export async function kickOutboundDrain(limit = 15, deadlineMs = 6000): Promise<void> {
  try {
    const admin = createAdminClient()
    await drainOutboundInventory(admin, { limit, deadlineMs })
  } catch {
    // Intentionally ignored: the scheduled drain will pick up pending jobs.
  }
}
