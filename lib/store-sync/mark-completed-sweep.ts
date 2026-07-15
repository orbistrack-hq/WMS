import type { SupabaseClient } from "@supabase/supabase-js"

import { markStoreCompleted } from "./store-completed"

// ---------------------------------------------------------------------------
// Nightly safety-net: stamp store_completed_at on orders the store marked
// completed but whose webhook was missed (dropped delivery, or the order.updated
// topic was never registered). MARK-ONLY — it never fulfils or changes status;
// local packing/fulfilment stays the team's manual step. Complements the
// real-time webhook path so nobody has to run a reconcile by hand.
// ---------------------------------------------------------------------------

const ACTIVE = new Set(["created", "picking", "packed"])

function authHeader(k: string, s: string) {
  return `Basic ${Buffer.from(`${k}:${s}`).toString("base64")}`
}

export type SweepSummary = {
  connections: number
  marked: number
  errors: number
}

/**
 * For each active WooCommerce store, re-fetch orders it marked COMPLETED in the
 * recent window and stamp store_completed_at on the matching WMS order when it's
 * still active and not already marked. Service-role client required. Bounded by
 * a soft deadline so a serverless cron finishes and returns cleanly.
 */
export async function sweepStoreCompleted(
  admin: SupabaseClient,
  opts: { sinceDays?: number; deadlineMs?: number } = {},
): Promise<SweepSummary> {
  const sinceDays = opts.sinceDays ?? 3
  const deadline = Date.now() + (opts.deadlineMs ?? 50_000)
  const modifiedAfter = new Date(
    Date.now() - sinceDays * 86_400_000,
  ).toISOString()

  const summary: SweepSummary = { connections: 0, marked: 0, errors: 0 }

  const { data: conns, error: cerr } = await admin
    .from("store_connections")
    .select("id, source, site_id")
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

    const base = `${conn.source}/wp-json/wc/v3`
    const auth = {
      Authorization: authHeader(secret.consumer_key, secret.consumer_secret),
    }

    // Completed orders modified in the window, newest first, paginated.
    for (let page = 1; page <= 20; page++) {
      if (Date.now() > deadline) break
      const res = await fetch(
        `${base}/orders?status=completed&modified_after=${encodeURIComponent(
          modifiedAfter,
        )}&per_page=100&page=${page}&orderby=modified&order=desc`,
        { headers: auth },
      )
      if (!res.ok) {
        summary.errors++
        break
      }
      const rows = (await res.json()) as Array<{
        id: number | string
        date_completed?: string | null
        date_completed_gmt?: string | null
        date_modified?: string | null
      }>
      if (!Array.isArray(rows) || rows.length === 0) break

      // Map external Woo ids -> WMS orders via store_order_imports.
      const extIds = rows.map((o) => String(o.id))
      const { data: imps } = await admin
        .from("store_order_imports")
        .select("external_order_id, wms_order_id")
        .eq("channel", "woocommerce")
        .eq("source", conn.source)
        .in("external_order_id", extIds)
        .not("wms_order_id", "is", null)
      const wmsByExt = new Map(
        (imps ?? []).map((r) => [
          String(r.external_order_id),
          r.wms_order_id as string,
        ]),
      )

      const wmsIds = [...wmsByExt.values()]
      if (wmsIds.length > 0) {
        const { data: ords } = await admin
          .from("orders")
          .select("id, status, store_completed_at")
          .in("id", wmsIds)
        const byId = new Map((ords ?? []).map((o) => [o.id as string, o]))

        for (const o of rows) {
          const wmsId = wmsByExt.get(String(o.id))
          if (!wmsId) continue
          const ord = byId.get(wmsId)
          if (
            !ord ||
            !ACTIVE.has(ord.status as string) ||
            ord.store_completed_at != null
          ) {
            continue
          }
          const at = o.date_completed_gmt
            ? `${o.date_completed_gmt}Z`
            : (o.date_completed ?? o.date_modified ?? null)
          const r = await markStoreCompleted(admin, wmsId, at)
          if (r.marked) summary.marked++
          else summary.errors++
        }
      }

      if (rows.length < 100) break
    }
  }

  return summary
}
