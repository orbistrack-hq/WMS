import type { SupabaseClient } from "@supabase/supabase-js"

import { fetchWooVariations, wooApiBase, wooAuthHeader } from "./rest"
import { wooCost, type WooProduct } from "./types"

// ---------------------------------------------------------------------------
// Nightly cost sweep: pull every cost from each WooCommerce store into WMS.
//
// The product.updated webhook already carries cost, but Woo only fires it when
// the product itself is SAVED. Cost-of-Goods plugin tools (bulk edit, import)
// write the cost meta straight to the post without a save, so those edits
// never reach WMS until someone runs a manual product sync. Shopify had the
// same gap and closed it with inventory_items/update; Woo has no equivalent
// topic, so this sweep re-reads costs on a schedule instead.
//
// Cost only. Price, stock, names and mappings stay with the product sync and
// webhooks. Same rule as the upsert RPCs (migration 0088): a POSITIVE store
// cost overwrites child_skus.cost; null or zero is "the store sent nothing" and
// leaves WMS alone. Children are matched by (site_id, store_variant_id), the
// same key the RPCs re-sync on; unmapped store items are ignored, never created.
// ---------------------------------------------------------------------------

export type CostChild = {
  id: string
  store_variant_id: string | null
  cost: number | string | null
}

export type CostUpdate = {
  childSkuId: string
  storeVariantId: string
  from: number
  to: number
}

export type CostSweepSummary = {
  connections: number
  storeItems: number
  updated: number
  failed: number
  timedOut: boolean
  firstError?: string
}

// Variation fetches in flight at once per store. Woo answers ~1-2s per call,
// so this keeps a ~150-product catalog well inside the cron's deadline without
// hammering a shared host.
const VARIATION_CONCURRENCY = 6

/**
 * Round to cents the way Postgres stores numeric(12,2) (half away from zero).
 * toPrecision first so a float like 9.765 * 100 = 976.4999… rounds up, as the
 * decimal 9.765 does in the database.
 */
export function toCents(n: number): number {
  return Math.round(Number((n * 100).toPrecision(12))) / 100
}

/**
 * Children whose cost differs from the store's positive cost. Pure, so the
 * matching rule is testable without a store or a database. Compared at cents
 * because child_skus.cost is numeric(12,2): a store cost of 9.765 is already
 * stored as 9.77, and rewriting it every night would change nothing.
 */
export function costUpdates(
  storeCosts: Map<string, number>,
  children: CostChild[],
): CostUpdate[] {
  const out: CostUpdate[] = []
  for (const c of children) {
    if (!c.store_variant_id) continue
    const raw = storeCosts.get(c.store_variant_id)
    if (raw === undefined || !(raw > 0)) continue
    const to = toCents(raw)
    const from = Number(c.cost ?? 0)
    if (Number.isFinite(from) && toCents(from) === to) continue
    out.push({ childSkuId: c.id, storeVariantId: c.store_variant_id, from, to })
  }
  return out
}

/**
 * Walk a store's catalog and return storeVariantId -> cost for every sellable
 * unit that carries a Cost-of-Goods value: each variation of a variable
 * product, or the product itself otherwise (the same ids the product sync maps).
 * Throws if the first product page fails; a later failure keeps what was read.
 */
export async function collectWooCosts(
  source: string,
  consumerKey: string,
  consumerSecret: string,
  deadline: number,
): Promise<{ costs: Map<string, number>; complete: boolean }> {
  const base = wooApiBase(source)
  const auth = { Authorization: wooAuthHeader(consumerKey, consumerSecret) }
  const costs = new Map<string, number>()
  const variableIds: string[] = []
  let complete = true

  for (let page = 1; page <= 50; page++) {
    if (Date.now() > deadline) {
      complete = false
      break
    }
    const r = await fetch(`${base}/products?per_page=100&page=${page}`, {
      headers: auth,
    })
    if (!r.ok) {
      if (page === 1) throw new Error(`products fetch failed (${r.status})`)
      complete = false
      break
    }
    const products = (await r.json()) as WooProduct[]
    if (!Array.isArray(products) || products.length === 0) break
    for (const p of products) {
      if (p.id == null) continue
      if ((p.type ?? "").toLowerCase() === "variable") {
        variableIds.push(String(p.id))
        continue
      }
      const c = wooCost(p.meta_data)
      if (c !== null) costs.set(String(p.id), c)
    }
    if (products.length < 100) break
  }

  let next = 0
  const worker = async () => {
    while (next < variableIds.length) {
      if (Date.now() > deadline) {
        complete = false
        return
      }
      const id = variableIds[next++]
      try {
        for (const v of await fetchWooVariations(base, auth, id)) {
          const c = wooCost(v.meta_data)
          if (v.id != null && c !== null) costs.set(String(v.id), c)
        }
      } catch {
        complete = false // one product's hiccup skips only its variations
      }
    }
  }
  await Promise.all(
    Array.from({ length: VARIATION_CONCURRENCY }, () => worker()),
  )

  return { costs, complete }
}

/**
 * For every active WooCommerce store, overwrite child SKU costs that drifted
 * from the store's Cost-of-Goods value. Service-role client required (reads
 * store_secrets). Best-effort per store and bounded by a soft deadline; a
 * partial read still applies the costs it did read.
 */
export async function sweepWooCosts(
  admin: SupabaseClient,
  opts: { deadlineMs?: number; dryRun?: boolean } = {},
): Promise<CostSweepSummary & { updates: CostUpdate[] }> {
  const deadline = Date.now() + (opts.deadlineMs ?? 50_000)
  const summary: CostSweepSummary & { updates: CostUpdate[] } = {
    connections: 0,
    storeItems: 0,
    updated: 0,
    failed: 0,
    timedOut: false,
    updates: [],
  }
  const fail = (msg: string) => {
    summary.failed++
    if (!summary.firstError) summary.firstError = msg
  }

  const { data: conns, error: cerr } = await admin
    .from("store_connections")
    .select("id, source, site_id")
    .eq("channel", "woocommerce")
    .eq("is_active", true)
  if (cerr) throw new Error(`load connections: ${cerr.message}`)

  for (const conn of conns ?? []) {
    if (Date.now() > deadline) {
      summary.timedOut = true
      break
    }
    const { data: secret } = await admin
      .from("store_secrets")
      .select("consumer_key, consumer_secret")
      .eq("connection_id", conn.id)
      .maybeSingle()
    if (!secret?.consumer_key || !secret?.consumer_secret) continue
    summary.connections++

    let costs: Map<string, number>
    try {
      const res = await collectWooCosts(
        conn.source as string,
        secret.consumer_key,
        secret.consumer_secret,
        deadline,
      )
      costs = res.costs
      if (!res.complete) summary.timedOut ||= Date.now() > deadline
    } catch (err) {
      fail(`${conn.source}: ${err instanceof Error ? err.message : "unreachable"}`)
      continue
    }
    summary.storeItems += costs.size

    const children: CostChild[] = []
    for (let from = 0; ; from += 1000) {
      const { data, error } = await admin
        .from("child_skus")
        .select("id, store_variant_id, cost")
        .eq("site_id", conn.site_id)
        .not("store_variant_id", "is", null)
        .order("id")
        .range(from, from + 999)
      if (error) {
        fail(`${conn.source}: load child SKUs: ${error.message}`)
        break
      }
      children.push(...((data ?? []) as CostChild[]))
      if (!data || data.length < 1000) break
    }

    for (const u of costUpdates(costs, children)) {
      summary.updates.push(u)
      if (opts.dryRun) continue
      const { error } = await admin
        .from("child_skus")
        .update({ cost: u.to })
        .eq("id", u.childSkuId)
      if (error) fail(`${conn.source}: update ${u.storeVariantId}: ${error.message}`)
      else summary.updated++
    }
  }

  return summary
}
