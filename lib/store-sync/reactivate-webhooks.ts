import type { SupabaseClient } from "@supabase/supabase-js"

import { wooApiBase } from "@/lib/woocommerce/rest"

// ---------------------------------------------------------------------------
// Self-heal: re-enable WooCommerce webhooks that Woo auto-DISABLED.
//
// WooCommerce flips a webhook's status to "disabled" after several consecutive
// failed deliveries (a bad-signature 401, a 500, or a timeout during a deploy /
// slow store). Once disabled it stays disabled until someone toggles it by hand,
// so orders and product edits silently stop syncing until it's noticed.
//
// This sweep runs on a schedule: for each active Woo store it lists the store's
// webhooks and PUTs status=active on any that (a) point at OUR delivery endpoint
// and (b) Woo has disabled. It deliberately leaves "paused" hooks alone — a
// pause is a human decision; "disabled" is the failure state we own.
//
// Matching is by endpoint PATH suffix, not the full URL, so it works regardless
// of which domain (prod vs. a preview) originally registered the hook. Requires
// a Read/Write consumer key (the PUT needs write); a Read-only key lists but
// can't reactivate, which surfaces as a per-connection error, not a throw.
// ---------------------------------------------------------------------------

// The path our receiver lives at (app/api/woocommerce/webhooks/route.ts).
const DELIVERY_PATH = "/api/woocommerce/webhooks"

function authHeader(k: string, s: string): string {
  return `Basic ${Buffer.from(`${k}:${s}`).toString("base64")}`
}

/** True when a stored delivery_url targets our webhook receiver (any host). */
function targetsUs(deliveryUrl: string | undefined | null): boolean {
  if (!deliveryUrl) return false
  try {
    return new URL(deliveryUrl).pathname === DELIVERY_PATH
  } catch {
    // Fall back to a suffix check if Woo ever returns a non-absolute URL.
    return deliveryUrl.endsWith(DELIVERY_PATH)
  }
}

export type ReactivateSummary = {
  connections: number
  disabledFound: number
  reactivated: number
  failed: number
  firstError?: string
}

type WooWebhook = {
  id: number | string
  status?: string
  topic?: string
  delivery_url?: string
}

/**
 * For every active WooCommerce store, reactivate any of OUR webhooks that Woo
 * disabled. Service-role client required (reads sealed store_secrets). Bounded
 * by a soft deadline so a serverless cron returns cleanly. Best-effort per
 * store: one store's bad credentials or Read-only key never blocks the others.
 */
export async function reactivateWooWebhooks(
  admin: SupabaseClient,
  opts: { deadlineMs?: number } = {},
): Promise<ReactivateSummary> {
  const deadline = Date.now() + (opts.deadlineMs ?? 50_000)
  const summary: ReactivateSummary = {
    connections: 0,
    disabledFound: 0,
    reactivated: 0,
    failed: 0,
  }

  const { data: conns, error: cerr } = await admin
    .from("store_connections")
    .select("id, source")
    .eq("channel", "woocommerce")
    .eq("is_active", true)
  if (cerr) throw new Error(`load connections: ${cerr.message}`)

  for (const conn of conns ?? []) {
    if (Date.now() > deadline) break

    const { data: secret } = await admin
      .from("store_secrets")
      .select("consumer_key, consumer_secret")
      .eq("connection_id", conn.id)
      .maybeSingle()
    if (!secret?.consumer_key || !secret?.consumer_secret) continue
    summary.connections++

    const base = wooApiBase(conn.source as string)
    const auth = authHeader(secret.consumer_key, secret.consumer_secret)

    // List the store's webhooks, disabled first, paginated.
    const disabled: WooWebhook[] = []
    try {
      for (let page = 1; page <= 10; page++) {
        if (Date.now() > deadline) break
        const res = await fetch(
          `${base}/webhooks?status=disabled&per_page=100&page=${page}`,
          { headers: { Authorization: auth } },
        )
        if (!res.ok) {
          summary.failed++
          if (!summary.firstError) {
            summary.firstError = `List webhooks failed (${res.status}) for ${conn.source}.`
          }
          break
        }
        const rows = (await res.json()) as WooWebhook[]
        if (!Array.isArray(rows) || rows.length === 0) break
        for (const w of rows) if (targetsUs(w.delivery_url)) disabled.push(w)
        if (rows.length < 100) break
      }
    } catch {
      summary.failed++
      if (!summary.firstError) {
        summary.firstError = `Could not reach ${conn.source}.`
      }
      continue
    }

    summary.disabledFound += disabled.length

    for (const w of disabled) {
      if (Date.now() > deadline) break
      try {
        const res = await fetch(`${base}/webhooks/${w.id}`, {
          method: "PUT",
          headers: { Authorization: auth, "Content-Type": "application/json" },
          body: JSON.stringify({ status: "active" }),
        })
        if (res.status === 200) {
          summary.reactivated++
        } else {
          summary.failed++
          if (!summary.firstError) {
            const detail =
              res.status === 401
                ? " (needs a Read/Write consumer key)"
                : ""
            summary.firstError = `Reactivate ${w.topic ?? "webhook"} failed (${res.status})${detail} for ${conn.source}.`
          }
        }
      } catch {
        summary.failed++
        if (!summary.firstError) {
          summary.firstError = `Reactivate request failed for ${conn.source}.`
        }
      }
    }
  }

  return summary
}
