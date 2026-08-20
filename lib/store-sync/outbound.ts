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
/**
 * Spacing between store API calls, per channel.
 *
 * Shopify's REST leaky bucket refills at 2 requests/second. The old flat 300ms
 * paced us at ~3.3/s, which drains the burst allowance and then earns a steady
 * stream of 429s — self-inflicted throttling that used to burn retry attempts
 * and trip the circuit breaker. 550ms keeps us just under the refill rate with
 * a little headroom for clock/latency jitter.
 *
 * Woo has no published global limit (it's the customer's own host), so its gap
 * only exists to be polite to a small origin.
 */
const PUSH_GAP_MS: Record<string, number> = {
  shopify: 550,
  woocommerce: 300,
}
const DEFAULT_PUSH_GAP_MS = 400
/** Fallback park when a 429 arrives without a usable Retry-After header. */
const DEFAULT_THROTTLE_BACKOFF_MS = 60_000
/**
 * How many jobs to claim per batch. Small, because claiming flips rows to
 * 'processing' and anything the run doesn't reach is invisible to the next drain
 * until the reaper frees it. See drainOutboundInventory.
 */
const CLAIM_BATCH_SIZE = 25

// --- Per-run circuit breaker -------------------------------------------------
// After this many consecutive transient failures on one store WITHIN a run, we
// stop pushing that store's remaining jobs and park them for the cooldown. Keeps
// one slow/down store from eating the drain's time budget and starving healthy
// stores. Parked jobs don't burn an attempt, so an outage doesn't march them to
// give-up — they just retry after the cooldown. Only transient failures count;
// permanent skips (bad mapping) don't trip it.
const CIRCUIT_FAIL_THRESHOLD = 3
const CIRCUIT_COOLDOWN_MS = 5 * 60 * 1000

export type DrainSummary = {
  claimed: number
  pushed: number
  skipped: number
  failed: number
  /**
   * Parked without penalty — by the circuit breaker (store tripped) or by rate
   * limiting. These are NOT lost: they return to 'pending' with a future
   * next_attempt_at and the scheduled drain picks them up. Report them
   * separately from `skipped`, which is terminal.
   */
  deferred?: number
  /** Subset of `deferred` that was parked because the store rate-limited us. */
  throttled?: number
  /** Store keys (channel:source) tripped this run. */
  trippedSources?: string[]
  /** True when we stopped early because the time budget (deadlineMs) elapsed. */
  deadlineHit?: boolean
  firstError?: string
  /**
   * Why the first permanently-skipped job was skipped. Reported separately from
   * firstError because a skip is a DATA problem the operator must fix (bad or
   * missing mapping), not a transport failure that will clear on its own — and
   * "31 skipped" with no reason attached is unactionable.
   */
  firstSkipReason?: string
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

/**
 * Outcome of a single push attempt.
 *   skip      — permanent (bad mapping, dead variant); terminal, no retry.
 *   retry     — transient (5xx, timeout, missing token); backoff + attempt burned.
 *   throttled — the store told us to slow down. NOT a failure of this job and
 *               not a signal the store is unhealthy: it means we asked too fast.
 *               Parking it costs nothing, whereas counting it as a retry burned
 *               an attempt (cap 8 -> permanently 'failed') and tripped the
 *               circuit breaker, punishing good data for our own pacing.
 */
type PushOutcome =
  | { ok: true }
  | { ok: false; kind: "skip"; error: string }
  | { ok: false; kind: "retry"; error: string }
  | { ok: false; kind: "throttled"; error: string; retryAfterMs: number }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Parse a Retry-After header. Shopify sends seconds (often fractional, e.g.
 * "2.0"); the HTTP spec also allows an absolute date. Clamped to something sane
 * so a hostile or garbled value can't park a job for hours.
 */
function retryAfterMs(header: string | null): number {
  if (!header) return DEFAULT_THROTTLE_BACKOFF_MS
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(Math.max(seconds * 1000, 1_000), 15 * 60 * 1000)
  }
  const when = Date.parse(header)
  if (Number.isFinite(when)) {
    const delta = when - Date.now()
    if (delta > 0) return Math.min(delta, 15 * 60 * 1000)
  }
  return DEFAULT_THROTTLE_BACKOFF_MS
}

/**
 * Claim and process up to `limit` due jobs. Safe to run concurrently (claims
 * use SKIP LOCKED) and safe to call repeatedly.
 *
 * `deadlineMs` (optional) is an overall wall-clock budget: once it elapses we
 * stop before claiming/processing further jobs and return what we've done so
 * far. Any already-claimed-but-unprocessed job is left 'processing' for the
 * reaper to recover — this is what stops a slow store from blocking the caller.
 *
 * Jobs are claimed in SMALL BATCHES inside a loop rather than one big up-front
 * claim, because job costs vary by three orders of magnitude: a push is a ~500ms
 * network round trip, while a skip (bad mapping) is pure DB work. A single claim
 * sized for the worst case wastes the whole run when the queue happens to be
 * full of skips — the symptom was a drain reporting "0 sent, 31 skipped" and
 * stopping, having never reached a single pushable SKU. Batching lets cheap
 * outcomes buy more work, and keeps unreached rows 'pending' (immediately
 * re-claimable) instead of stranded in 'processing' until the reaper.
 */
export async function drainOutboundInventory(
  admin: SupabaseClient,
  opts: { limit?: number; deadlineMs?: number } = {},
): Promise<DrainSummary> {
  const limit = opts.limit ?? 50
  const deadline =
    opts.deadlineMs && opts.deadlineMs > 0 ? Date.now() + opts.deadlineMs : Infinity
  const summary: DrainSummary = { claimed: 0, pushed: 0, skipped: 0, failed: 0 }

  // Resolve credentials once per source (avoid re-reading the sealed secrets
  // table for every job of the same store). Shopify: an access token; Woo: a
  // consumer key/secret pair. Held across batches — the whole point is that a
  // run is one conversation with the store.
  const tokenBySource = new Map<string, string | null>()
  const wooCredsBySource = new Map<string, WooCreds | null>()

  // Circuit-breaker state (per run). Key a store by channel+source.
  const consecutiveFails = new Map<string, number>()
  const tripped = new Set<string>()
  const cooldownUntil = new Date(Date.now() + CIRCUIT_COOLDOWN_MS).toISOString()
  const storeKey = (job: ClaimedJob) => `${job.channel ?? "?"}:${job.source ?? "?"}`

  // Rate-limit state (per run). Once a store 429s, every remaining job for it is
  // parked at the same wake-up time instead of being fired into the same wall.
  // Separate from `tripped` because throttling isn't a health signal and must
  // not count toward CIRCUIT_FAIL_THRESHOLD.
  const throttledUntil = new Map<string, string>()

  while (summary.claimed < limit) {
    if (Date.now() >= deadline) {
      summary.deadlineHit = true
      break
    }

    const { data, error } = await admin.rpc("claim_outbound_inventory_jobs", {
      p_limit: Math.min(CLAIM_BATCH_SIZE, limit - summary.claimed),
    })
    if (error) {
      if (!summary.firstError) summary.firstError = error.message
      break
    }
    const jobs = (data ?? []) as ClaimedJob[]
    if (jobs.length === 0) break // queue drained
    summary.claimed += jobs.length

    for (let i = 0; i < jobs.length; i++) {
      // Time budget: bail before touching the next job once the deadline passes.
      // Remaining claimed jobs stay 'processing'; the reaper resets them to
      // 'pending' and the next drain retries them.
      if (Date.now() >= deadline) {
        summary.deadlineHit = true
        break
      }

      const job = jobs[i]
      const key = storeKey(job)

      // Circuit open for this store: park the job for the cooldown instead of
      // spending a timeout on a store we already know is failing. No API call, no
      // attempt burned. It retries once the cooldown elapses.
      if (tripped.has(key)) {
        await deferJob(admin, job.job_id, cooldownUntil)
        summary.deferred = (summary.deferred ?? 0) + 1
        continue
      }

      // Store already rate-limited us this run: park at the same wake-up time
      // rather than spending another call to be told the same thing.
      const throttleUntil = throttledUntil.get(key)
      if (throttleUntil) {
        await deferJob(admin, job.job_id, throttleUntil)
        summary.deferred = (summary.deferred ?? 0) + 1
        summary.throttled = (summary.throttled ?? 0) + 1
        continue
      }

      const outcome = await pushJob(admin, job, tokenBySource, wooCredsBySource)

      if (outcome.ok) {
        summary.pushed++
        consecutiveFails.set(key, 0) // healthy again — reset the counter
        await complete(admin, job.job_id, { ok: true })
      } else if (outcome.kind === "skip") {
        // Permanent (bad mapping / disabled connection): terminal, and it does NOT
        // reflect store health, so it must not trip the breaker.
        summary.skipped++
        if (!summary.firstSkipReason) summary.firstSkipReason = outcome.error
        await complete(admin, job.job_id, { ok: false, skip: true, error: outcome.error })
      } else if (outcome.kind === "throttled") {
        // We asked too fast. Park this job and the rest of this store's jobs until
        // the store says it's ready. No attempt burned, breaker untouched.
        const until = new Date(Date.now() + outcome.retryAfterMs).toISOString()
        throttledUntil.set(key, until)
        await deferJob(admin, job.job_id, until)
        summary.deferred = (summary.deferred ?? 0) + 1
        summary.throttled = (summary.throttled ?? 0) + 1
        if (!summary.firstError) summary.firstError = outcome.error
      } else {
        // Transient failure (timeout / 5xx / auth): retryable, and a signal the
        // store may be unhealthy. Count it; trip the breaker at the threshold.
        summary.failed++
        if (!summary.firstError) summary.firstError = outcome.error
        const n = (consecutiveFails.get(key) ?? 0) + 1
        consecutiveFails.set(key, n)
        if (n >= CIRCUIT_FAIL_THRESHOLD) {
          tripped.add(key)
          summary.trippedSources = [...(summary.trippedSources ?? []), key]
        }
        await complete(admin, job.job_id, { ok: false, skip: false, error: outcome.error })
      }

      // Space out real API calls; skips (no network) don't need the gap. Pace by
      // the channel we just called, not a single global constant — Shopify's 2/s
      // bucket is much tighter than a self-hosted Woo origin's.
      if (outcome.ok || outcome.kind !== "skip") {
        if (i < jobs.length - 1) {
          await sleep(
            PUSH_GAP_MS[job.channel ?? ""] ?? DEFAULT_PUSH_GAP_MS,
          )
        }
      }
    }

    // The inner loop only breaks on the deadline; propagate that out of the
    // batch loop so we don't claim another batch we can't process.
    if (summary.deadlineHit) break
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
    return { ok: false, kind: "skip", error: "No active outbound connection for this site." }
  }
  if (job.channel === "shopify") return pushShopify(admin, job, tokenBySource)
  if (job.channel === "woocommerce") return pushWoo(admin, job, wooCredsBySource)
  return {
    ok: false,
    kind: "skip",
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
      kind: "skip",
      error: "Missing Shopify inventory_item_id — re-sync products to map it.",
    }
  }
  if (!job.inventory_location_id) {
    return {
      ok: false,
      kind: "skip",
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
    return { ok: false, kind: "retry", error: "Store access token not set." }
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
      return { ok: false, kind: "skip", error: msg }
    }
    // 429: we exceeded the leaky bucket. Park, don't penalise — see PushOutcome.
    if (r.status === 429) {
      return {
        ok: false,
        kind: "throttled",
        error: msg,
        retryAfterMs: retryAfterMs(r.headers.get("retry-after")),
      }
    }
    // 5xx / auth: transient or fixable — retry with backoff.
    return { ok: false, kind: "retry", error: msg }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "network error"
    return { ok: false, kind: "retry", error: `Could not reach Shopify: ${msg}` }
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
      kind: "skip",
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
    return { ok: false, kind: "retry", error: "Store API credentials not set." }
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
      // Shorter than Shopify's: an unhealthy Woo origin (budclub's 502/timeout)
      // otherwise stalls the whole run for 10s per job and starves the healthy
      // stores of the drain's time budget. A live Woo answers a single-product
      // PUT well under this; a dead one fails fast and frees the budget.
      signal: AbortSignal.timeout(5_000),
    })

    if (r.ok) return { ok: true }

    const body = await r.text().catch(() => "")
    const msg = `WooCommerce ${r.status}: ${body.slice(0, 300)}`
    // 400/404 mean the product/variation id is wrong — retrying won't help.
    if (r.status === 400 || r.status === 404) {
      return { ok: false, kind: "skip", error: msg }
    }
    // 429: a WAF or host-level limiter (Woo itself has none). Same treatment as
    // Shopify — park, don't penalise the job for our pacing.
    if (r.status === 429) {
      return {
        ok: false,
        kind: "throttled",
        error: msg,
        retryAfterMs: retryAfterMs(r.headers.get("retry-after")),
      }
    }
    // 5xx / auth: transient or fixable — retry with backoff.
    return { ok: false, kind: "retry", error: msg }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "network error"
    return { ok: false, kind: "retry", error: `Could not reach WooCommerce: ${msg}` }
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
 * Park a claimed job for the circuit-breaker cooldown: back to 'pending' at
 * next_attempt_at=until, attempts/last_error untouched (NOT a failure). If the
 * RPC is unavailable (older DB), swallow it — the job stays 'processing' and the
 * reaper recovers it, so the breaker degrades to "no worse than before".
 */
async function deferJob(
  admin: SupabaseClient,
  jobId: string,
  until: string,
): Promise<void> {
  try {
    await admin.rpc("defer_outbound_inventory_job", { p_job_id: jobId, p_until: until })
  } catch {
    // Intentionally ignored — reaper is the safety net.
  }
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
