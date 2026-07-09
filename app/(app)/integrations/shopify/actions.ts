"use server"

import { revalidatePath } from "next/cache"
import { headers } from "next/headers"

import { createClient } from "@/lib/supabase/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { importShopifyProduct } from "@/lib/shopify/import-products"
import { importNormalizedOrder } from "@/lib/shopify/import-orders"
import {
  getJob,
  saveJob,
  startOrResumeJob,
  toProgress,
  type JobProgress,
} from "@/lib/store-sync/jobs"
import { drainOutboundInventory, kickOutboundDrain } from "@/lib/store-sync/outbound"
import {
  normalizeGraphqlOrder,
  type ShopifyGraphqlOrdersPage,
  type ShopifyInventoryItem,
  type ShopifyProduct,
} from "@/lib/shopify/types"

const SHOPIFY_API_VERSION = "2024-10"

export type ActionResult = { ok: true } | { ok: false; error: string }
export type SyncResult =
  | {
      ok: true
      products: number
      created: number
      updated: number
      skipped: number
      costSeeded: number
      stockSynced: number
      warning?: string
    }
  | { ok: false; error: string }

type PgError = { message?: string; details?: string; code?: string } | null

function err(error: PgError): string {
  if (!error) return "Something went wrong."
  if (error.code === "42501")
    return "Only an admin can manage Shopify connections."
  if (error.code === "23505")
    return "That store domain is already connected."
  return error.message || error.details || "Something went wrong."
}

function normalizeDomain(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
}

export async function createConnection(
  shopDomain: string,
  siteId: string,
): Promise<ActionResult> {
  const domain = normalizeDomain(shopDomain)
  if (!domain) return { ok: false, error: "Enter the store's myshopify.com domain." }
  if (!siteId) return { ok: false, error: "Pick the WMS site this store feeds." }

  const supabase = await createClient()
  const { error } = await supabase
    .from("store_connections")
    .insert({ channel: "shopify", source: domain, site_id: siteId })
  if (error) return { ok: false, error: err(error) }

  revalidatePath("/integrations/shopify")
  return { ok: true }
}

export async function setConnectionActive(
  id: string,
  isActive: boolean,
): Promise<ActionResult> {
  const supabase = await createClient()
  const { error } = await supabase
    .from("store_connections")
    .update({ is_active: isActive })
    .eq("id", id)
  if (error) return { ok: false, error: err(error) }

  revalidatePath("/integrations/shopify")
  return { ok: true }
}

export async function deleteConnection(id: string): Promise<ActionResult> {
  const supabase = await createClient()
  const { error } = await supabase
    .from("store_connections")
    .delete()
    .eq("id", id)
  if (error) return { ok: false, error: err(error) }

  revalidatePath("/integrations/shopify")
  return { ok: true }
}

/**
 * Turn OUTBOUND inventory sync on/off for one connection (migration 0026). Off
 * by default so stores are enabled one at a time. Enabling it makes future WMS
 * stock changes push `available` to this store; turning it on also nudges the
 * drain so any already-queued jobs go out promptly.
 */
export async function setInventoryOutbound(
  id: string,
  enabled: boolean,
): Promise<ActionResult> {
  const supabase = await createClient()
  const { error } = await supabase
    .from("store_connections")
    .update({ sync_inventory_outbound: enabled })
    .eq("id", id)
  if (error) return { ok: false, error: err(error) }

  if (enabled) await kickOutboundDrain()
  revalidatePath("/integrations/shopify")
  return { ok: true }
}

/** Manually drain the outbound inventory queue now (Sync inventory button). */
export async function runOutboundDrainNow(): Promise<
  | { ok: true; pushed: number; skipped: number; failed: number; firstError?: string }
  | { ok: false; error: string }
> {
  // Authorize: any user who can reach an outbound-enabled connection. The drain
  // itself runs with the service role (claim/complete are sealed to it).
  const supabase = await createClient()
  const { data: conns, error: connErr } = await supabase
    .from("store_connections")
    .select("id")
    .eq("sync_inventory_outbound", true)
    .limit(1)
  if (connErr) return { ok: false, error: err(connErr) }
  if (!conns || conns.length === 0)
    return { ok: false, error: "No store has outbound inventory sync enabled." }

  try {
    const summary = await drainOutboundInventory(createAdminClient(), { limit: 200 })
    revalidatePath("/integrations/shopify")
    return {
      ok: true,
      pushed: summary.pushed,
      skipped: summary.skipped,
      failed: summary.failed,
      firstError: summary.firstError,
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Drain failed." }
  }
}

/**
 * Best-effort capture of the store's primary location id onto the connection,
 * used as the target for outbound stock writes. Only sets it when unset.
 */
async function captureShopifyLocation(
  connectionId: string,
  source: string,
  token: string,
): Promise<void> {
  try {
    const admin = createAdminClient()
    const { data: c } = await admin
      .from("store_connections")
      .select("inventory_location_id")
      .eq("id", connectionId)
      .maybeSingle()
    if (c?.inventory_location_id) return

    const r = await fetch(
      `https://${source}/admin/api/${SHOPIFY_API_VERSION}/locations.json`,
      {
        headers: {
          "X-Shopify-Access-Token": token,
          "Content-Type": "application/json",
        },
      },
    )
    if (!r.ok) return
    const body = (await r.json()) as {
      locations?: { id: number; active?: boolean }[]
    }
    const locs = body.locations ?? []
    const loc = locs.find((l) => l.active !== false) ?? locs[0]
    if (loc?.id != null) {
      await admin
        .from("store_connections")
        .update({ inventory_location_id: String(loc.id) })
        .eq("id", connectionId)
    }
  } catch {
    // non-fatal; an admin can set the location later or re-sync
  }
}

/**
 * Store/replace a store's credentials. Blank fields are left unchanged, so the
 * client can update one without re-entering the other. RLS scopes this to users
 * who can access the connection's site.
 */
export async function setCredentials(
  connectionId: string,
  accessToken: string,
  apiSecret: string,
): Promise<ActionResult> {
  const token = accessToken.trim()
  const secret = apiSecret.trim()
  if (!token && !secret)
    return { ok: false, error: "Enter the access token and/or API secret." }

  const supabase = await createClient()

  // Authorize first: the caller must be able to see this connection (RLS is
  // site-scoped). store_secrets itself is sealed from the API role, so we
  // can't lean on its RLS — we gate on the connection the user CAN read.
  const { data: conn } = await supabase
    .from("store_connections")
    .select("id")
    .eq("id", connectionId)
    .maybeSingle()
  if (!conn) return { ok: false, error: "Connection not found or access denied." }

  // Read/write the secret with the service role: the secrets table is reachable
  // only from trusted server code, never the public Data API.
  const admin = createAdminClient()

  // Merge with any existing values so a blank field keeps the current one.
  const { data: existing } = await admin
    .from("store_secrets")
    .select("access_token, api_secret")
    .eq("connection_id", connectionId)
    .maybeSingle()

  const { error } = await admin.from("store_secrets").upsert(
    {
      connection_id: connectionId,
      access_token: token || existing?.access_token || null,
      api_secret: secret || existing?.api_secret || null,
    },
    { onConflict: "connection_id" },
  )
  if (error) return { ok: false, error: err(error) }

  revalidatePath("/integrations/shopify")
  return { ok: true }
}

/** Turn a Shopify Admin API error response into a readable, actionable message. */
function shopifyApiError(status: number, body: string): string {
  let detail = ""
  try {
    const j = JSON.parse(body)
    detail =
      typeof j?.errors === "string"
        ? j.errors
        : j?.errors
          ? JSON.stringify(j.errors)
          : ""
  } catch {
    detail = body.slice(0, 200)
  }
  const hint =
    status === 403
      ? " The token is likely missing a required scope (e.g. read_products) — add it to the custom app, reinstall, and update the token."
      : status === 401
        ? " The access token is invalid or revoked — generate a fresh one."
        : status === 404
          ? " Check the store domain — it must be the xxx.myshopify.com admin domain."
          : ""
  return `Shopify API ${status}${detail ? `: ${detail}` : ""}.${hint}`
}

/** Extract the rel="next" URL from a Shopify Link header, if any. */
function nextPageUrl(linkHeader: string | null): string | null {
  if (!linkHeader) return null
  for (const part of linkHeader.split(",")) {
    const m = part.match(/<([^>]+)>;\s*rel="next"/)
    if (m) return m[1]
  }
  return null
}

/**
 * Pull unit costs for a set of Shopify InventoryItems (cost lives there, not on
 * the variant). Batched ≤100 ids per call. A non-OK response (typically a token
 * missing the read_inventory scope) is non-fatal: we return what we have plus a
 * flag so the caller can sync price/stock and just skip cost seeding.
 */
async function fetchVariantCosts(
  shopDomain: string,
  token: string,
  inventoryItemIds: string[],
): Promise<{ costs: Map<string, number>; unavailable: boolean }> {
  const costs = new Map<string, number>()
  const ids = [...new Set(inventoryItemIds)]

  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100)
    const url = `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/inventory_items.json?ids=${chunk.join(
      ",",
    )}&limit=250`
    const r = await fetch(url, {
      headers: {
        "X-Shopify-Access-Token": token,
        "Content-Type": "application/json",
      },
    })
    if (!r.ok) {
      console.error(`[shopify] inventory_items ${r.status} — skipping cost sync`)
      return { costs, unavailable: true }
    }
    const body = (await r.json()) as { inventory_items?: ShopifyInventoryItem[] }
    for (const it of body.inventory_items ?? []) {
      if (it.id != null && it.cost != null) {
        const c = Number(it.cost)
        if (Number.isFinite(c)) costs.set(String(it.id), c)
      }
    }
  }
  return { costs, unavailable: false }
}

/**
 * Backfill: pull every product from the connected store via the Admin API and
 * upsert each variant into the catalog — including price, unit cost (seeded
 * only when WMS has none), and available stock (synced into WMS on_hand, logged,
 * reservations preserved). Runs server-side with the store's token (which never
 * leaves the server). Ongoing changes still arrive via product webhooks.
 */
export async function syncProducts(connectionId: string): Promise<SyncResult> {
  const supabase = await createClient()

  const { data: conn, error: connErr } = await supabase
    .from("store_connections")
    .select("source, site_id")
    .eq("id", connectionId)
    .maybeSingle()
  if (connErr) return { ok: false, error: err(connErr) }
  if (!conn) return { ok: false, error: "Connection not found." }

  // Secret read goes through the service role; the connection select above (user
  // client, RLS) is what authorizes the caller for this connection's site.
  const admin = createAdminClient()
  const { data: secret } = await admin
    .from("store_secrets")
    .select("access_token")
    .eq("connection_id", connectionId)
    .maybeSingle()
  if (!secret?.access_token) {
    return {
      ok: false,
      error: "Set this store's Admin API access token first.",
    }
  }
  const token = secret.access_token

  // Capture the store's primary location id for OUTBOUND stock writes
  // (migration 0026). Only set it when unset, so an admin's explicit choice is
  // preserved. Best-effort — never blocks the catalog sync.
  await captureShopifyLocation(connectionId, conn.source as string, token)

  // Phase 1: page through every product, collecting them plus the inventory
  // item ids we'll need cost for.
  const products: ShopifyProduct[] = []
  const inventoryItemIds: string[] = []
  let url: string | null =
    `https://${conn.source}/admin/api/${SHOPIFY_API_VERSION}/products.json?limit=250`

  try {
    for (let page = 0; url && page < 40; page++) {
      const r: Response = await fetch(url, {
        headers: {
          "X-Shopify-Access-Token": token,
          "Content-Type": "application/json",
        },
      })
      if (!r.ok) {
        const raw = await r.text().catch(() => "")
        console.error(`[shopify] product sync ${r.status}: ${raw}`)
        return { ok: false, error: shopifyApiError(r.status, raw) }
      }
      const body = (await r.json()) as { products?: ShopifyProduct[] }
      for (const product of body.products ?? []) {
        products.push(product)
        for (const v of product.variants ?? []) {
          if (v.inventory_item_id != null)
            inventoryItemIds.push(String(v.inventory_item_id))
        }
      }
      url = nextPageUrl(r.headers.get("link"))
    }
  } catch {
    return { ok: false, error: "Could not reach Shopify. Try again." }
  }

  // Phase 2: pull costs (best-effort — cost seeding is skipped if unavailable).
  let costByInventoryItemId = new Map<string, number>()
  let costUnavailable = false
  try {
    const r = await fetchVariantCosts(conn.source, token, inventoryItemIds)
    costByInventoryItemId = r.costs
    costUnavailable = r.unavailable
  } catch {
    costUnavailable = true
  }

  // Phase 3: upsert each variant with price + cost + stock.
  const totals = {
    products: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    costSeeded: 0,
    stockSynced: 0,
  }
  let firstError: string | undefined
  for (const product of products) {
    // Catalog write goes through the service role (like the order-import path):
    // the parent product is created before its child SKU exists, so under the
    // site-scoped products_read policy a non-operator caller's user client would
    // be rejected on the parent's RETURNING. The caller was already authorized
    // for this site by the RLS store_connections read above.
    const res = await importShopifyProduct(
      admin,
      conn.site_id as string,
      product,
      { costByInventoryItemId, syncInventory: true },
    )
    totals.products++
    totals.created += res.created
    totals.updated += res.updated
    totals.skipped += res.skipped
    totals.costSeeded += res.costSeeded
    totals.stockSynced += res.stockSynced
    if (!firstError && res.firstError) firstError = res.firstError
  }

  // Every variant failed to write — surface the real reason instead of a
  // misleading "success" with zero imports.
  if (totals.created === 0 && totals.updated === 0 && totals.skipped > 0) {
    console.error(`[shopify] all ${totals.skipped} variants skipped: ${firstError}`)
    return {
      ok: false,
      error: `All ${totals.skipped} variants were skipped — the catalog write is failing${firstError ? `: ${firstError}` : "."}`,
    }
  }

  await supabase
    .from("store_connections")
    .update({ last_synced_at: new Date().toISOString() })
    .eq("id", connectionId)

  revalidatePath("/integrations/shopify")
  revalidatePath("/catalog")
  revalidatePath("/inventory")
  // Cost and stock both need the read_inventory scope; if cost was blocked and
  // no stock came through either, point at the scope rather than failing.
  const warning =
    costUnavailable && totals.stockSynced === 0
      ? "Price and names synced, but cost and stock were skipped — add the read_inventory scope to the Admin API token, then sync again."
      : costUnavailable
        ? "Cost was skipped (token may be missing the read_inventory scope). Price and stock synced."
        : undefined
  return { ok: true, ...totals, warning }
}

export type RegisterResult =
  | { ok: true; created: number; existing: number; failed: number }
  | { ok: false; error: string }

const WEBHOOK_TOPICS = [
  "orders/create",
  // Lifecycle updates so order status keeps flowing after creation. "updated"
  // is the catch-all; fulfilled/cancelled are explicit for promptness.
  "orders/updated",
  "orders/fulfilled",
  "orders/cancelled",
  "products/create",
  "products/update",
  "products/delete",
  // Inbound stock signal. Subscribed so deliveries arrive; the processor leaves
  // the apply unwired until echo-loop protection lands (see process-event.ts).
  "inventory_levels/update",
]

/**
 * Register the WMS webhook endpoint on the store via the Admin API, so the
 * client doesn't have to create webhooks by hand. Webhooks created this way are
 * HMAC-signed with the app's API secret — the same secret stored for per-store
 * verification.
 */
export async function registerWebhooks(
  connectionId: string,
): Promise<RegisterResult> {
  const supabase = await createClient()

  const { data: conn } = await supabase
    .from("store_connections")
    .select("source")
    .eq("id", connectionId)
    .maybeSingle()
  if (!conn) return { ok: false, error: "Connection not found." }

  // Secret read goes through the service role; the connection select above (user
  // client, RLS) is what authorizes the caller for this connection's site.
  const { data: secret } = await createAdminClient()
    .from("store_secrets")
    .select("access_token")
    .eq("connection_id", connectionId)
    .maybeSingle()
  if (!secret?.access_token) {
    return { ok: false, error: "Set this store's Admin API access token first." }
  }

  const h = await headers()
  const host = h.get("host")
  if (!host) return { ok: false, error: "Could not determine the callback URL." }
  const proto = host.startsWith("localhost") ? "http" : "https"
  const address = `${proto}://${host}/api/shopify/webhooks`

  const result = { created: 0, existing: 0, failed: 0 }
  try {
    for (const topic of WEBHOOK_TOPICS) {
      const r = await fetch(
        `https://${conn.source}/admin/api/${SHOPIFY_API_VERSION}/webhooks.json`,
        {
          method: "POST",
          headers: {
            "X-Shopify-Access-Token": secret.access_token,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ webhook: { topic, address, format: "json" } }),
        },
      )
      if (r.status === 201) result.created++
      else if (r.status === 422)
        result.existing++ // already subscribed to this topic/address
      else result.failed++
    }
  } catch {
    return { ok: false, error: "Could not reach Shopify. Try again." }
  }

  revalidatePath("/integrations/shopify")
  return { ok: true, ...result }
}

// ---------------------------------------------------------------------------
// Past-order backfill (GraphQL)
// ---------------------------------------------------------------------------
export type OrderSyncResult =
  | {
      ok: true
      fetched: number
      imported: number
      duplicates: number
      needsMapping: number
      skipped: number
      firstError?: string
    }
  | { ok: false; error: string }

// Pull historical orders oldest-first so backdated WMS orders land in order.
const PAST_ORDERS_QUERY = `
  query PastOrders($cursor: String) {
    orders(first: 100, after: $cursor, sortKey: CREATED_AT, query: "status:any") {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        name
        email
        note
        createdAt
        displayFulfillmentStatus
        closed
        closedAt
        cancelledAt
        customer { id email firstName lastName }
        shippingAddress {
          name address1 address2 city province provinceCode zip country countryCode
        }
        lineItems(first: 100) {
          nodes {
            quantity
            title
            variant { id }
            originalUnitPriceSet { shopMoney { amount } }
          }
        }
      }
    }
  }`

type GraphqlResponse<T> = {
  data?: T
  errors?: { message: string; extensions?: { code?: string } }[]
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Backfill: page through the store's historical orders via the GraphQL Admin
 * API and import each one into WMS (idempotent — re-running skips orders already
 * imported). Requires the read_orders scope; orders older than 60 days also need
 * read_all_orders (Shopify grants it on request). Ongoing orders still arrive
 * through the orders/create webhook.
 */
export async function syncPastOrders(
  connectionId: string,
): Promise<OrderSyncResult> {
  const supabase = await createClient()

  // Authorize via the RLS-scoped connection read (same pattern as syncProducts).
  const { data: conn, error: connErr } = await supabase
    .from("store_connections")
    .select("source, site_id, is_active")
    .eq("id", connectionId)
    .maybeSingle()
  if (connErr) return { ok: false, error: err(connErr) }
  if (!conn) return { ok: false, error: "Connection not found." }
  if (!conn.is_active)
    return { ok: false, error: "Activate this connection before syncing." }

  const admin = createAdminClient()
  const { data: secret } = await admin
    .from("store_secrets")
    .select("access_token")
    .eq("connection_id", connectionId)
    .maybeSingle()
  if (!secret?.access_token) {
    return { ok: false, error: "Set this store's Admin API access token first." }
  }
  const token = secret.access_token
  const shopDomain = conn.source as string
  const siteId = conn.site_id as string
  const endpoint = `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`

  const result = {
    fetched: 0,
    imported: 0,
    duplicates: 0,
    needsMapping: 0,
    skipped: 0,
  }
  let firstError: string | undefined
  let cursor: string | null = null
  let throttleRetries = 0

  // Imports use the service role: store_order_imports has no RLS write policy.
  for (let page = 0; page < 200; page++) {
    let body: GraphqlResponse<{ orders: ShopifyGraphqlOrdersPage }>
    try {
      const r = await fetch(endpoint, {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: PAST_ORDERS_QUERY,
          variables: { cursor },
        }),
      })
      if (!r.ok) {
        const raw = await r.text().catch(() => "")
        console.error(`[shopify] order backfill ${r.status}: ${raw}`)
        return { ok: false, error: shopifyApiError(r.status, raw) }
      }
      body = (await r.json()) as typeof body
    } catch {
      return { ok: false, error: "Could not reach Shopify. Try again." }
    }

    if (body.errors?.length) {
      const throttled = body.errors.some(
        (e) => e.extensions?.code === "THROTTLED",
      )
      if (throttled && throttleRetries < 5) {
        throttleRetries++
        await sleep(2000)
        page-- // retry the same cursor
        continue
      }
      return { ok: false, error: body.errors.map((e) => e.message).join("; ") }
    }
    throttleRetries = 0

    const ordersPage = body.data?.orders
    if (!ordersPage) break

    for (const node of ordersPage.nodes ?? []) {
      result.fetched++
      const order = normalizeGraphqlOrder(node)
      const outcome = await importNormalizedOrder(
        admin,
        siteId,
        shopDomain,
        order,
        "orders/backfill",
        node,
      )
      switch (outcome.status) {
        case "imported":
          result.imported++
          break
        case "duplicate":
          result.duplicates++
          break
        case "needs_mapping":
          result.needsMapping++
          if (!firstError)
            firstError = `Order ${order.name ?? order.shopifyOrderId} has unmapped variants — sync products first.`
          break
        case "skipped":
          result.skipped++
          break
        case "error":
          result.skipped++
          if (!firstError) firstError = outcome.error
          break
      }
    }

    if (!ordersPage.pageInfo?.hasNextPage) break
    cursor = ordersPage.pageInfo.endCursor
    if (!cursor) break
  }

  if (result.imported > 0) {
    await supabase
      .from("store_connections")
      .update({ last_synced_at: new Date().toISOString() })
      .eq("id", connectionId)
  }

  revalidatePath("/integrations/shopify")
  revalidatePath("/orders")
  return { ok: true, ...result, firstError }
}

// ---------------------------------------------------------------------------
// Background past-order import (resumable, chunked) — one page per call.
//
// syncPastOrders() above runs the whole backfill in a single request, which
// blocks the page and risks timeouts on large stores. These three actions drive
// the same import through a store_sync_jobs row instead: the UI starts a job and
// calls stepOrderImport() repeatedly (one GraphQL page each) until done, so each
// request is short and progress is visible + resumable. Idempotency still lives
// in store_order_imports, so a replayed page never double-imports.
// ---------------------------------------------------------------------------

export type ImportStepResult =
  | { ok: true; job: JobProgress }
  | { ok: false; error: string }

/** Start (or resume) the Shopify past-order import for a connection. */
export async function startOrderImport(
  connectionId: string,
): Promise<ImportStepResult> {
  const supabase = await createClient()
  const { data: conn, error: connErr } = await supabase
    .from("store_connections")
    .select("is_active")
    .eq("id", connectionId)
    .maybeSingle()
  if (connErr) return { ok: false, error: err(connErr) }
  if (!conn) return { ok: false, error: "Connection not found." }
  if (!conn.is_active)
    return { ok: false, error: "Activate this connection before syncing." }

  try {
    const job = await startOrResumeJob(createAdminClient(), connectionId, "shopify")
    return { ok: true, job: toProgress(job) }
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Could not start the import.",
    }
  }
}

/** Cancel an in-flight import. */
export async function cancelOrderImport(
  jobId: string,
): Promise<ImportStepResult> {
  const admin = createAdminClient()
  const job = await getJob(admin, jobId)
  if (!job) return { ok: false, error: "Import job not found." }

  // Authorize: caller must be able to see the job's connection (site-scoped RLS).
  const supabase = await createClient()
  const { data: conn } = await supabase
    .from("store_connections")
    .select("id")
    .eq("id", job.connection_id)
    .maybeSingle()
  if (!conn) return { ok: false, error: "Access denied." }

  const updated = await saveJob(admin, jobId, {
    status: "cancelled",
    finished_at: new Date().toISOString(),
  })
  return { ok: true, job: toProgress(updated) }
}

/** Import ONE page of past orders, advancing (and persisting) the cursor. */
export async function stepOrderImport(
  jobId: string,
): Promise<ImportStepResult> {
  const admin = createAdminClient()
  const job = await getJob(admin, jobId)
  if (!job) return { ok: false, error: "Import job not found." }
  if (job.status !== "running") return { ok: true, job: toProgress(job) }

  const supabase = await createClient()
  const { data: conn } = await supabase
    .from("store_connections")
    .select("source, site_id")
    .eq("id", job.connection_id)
    .maybeSingle()
  if (!conn) return { ok: false, error: "Access denied." }

  const { data: secret } = await admin
    .from("store_secrets")
    .select("access_token")
    .eq("connection_id", job.connection_id)
    .maybeSingle()
  if (!secret?.access_token) {
    const u = await saveJob(admin, jobId, {
      status: "failed",
      last_error: "Set this store's Admin API access token first.",
    })
    return { ok: true, job: toProgress(u) }
  }

  const token = secret.access_token as string
  const shopDomain = conn.source as string
  const siteId = conn.site_id as string
  const endpoint = `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`

  let body: GraphqlResponse<{ orders: ShopifyGraphqlOrdersPage }>
  try {
    const r = await fetch(endpoint, {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: PAST_ORDERS_QUERY,
        variables: { cursor: job.cursor },
      }),
    })
    if (!r.ok) {
      const raw = await r.text().catch(() => "")
      const u = await saveJob(admin, jobId, {
        status: "failed",
        last_error: shopifyApiError(r.status, raw),
      })
      return { ok: true, job: toProgress(u) }
    }
    body = (await r.json()) as typeof body
  } catch {
    const u = await saveJob(admin, jobId, {
      status: "failed",
      last_error: "Could not reach Shopify. Run again to resume.",
    })
    return { ok: true, job: toProgress(u) }
  }

  if (body.errors?.length) {
    const throttled = body.errors.some((e) => e.extensions?.code === "THROTTLED")
    // Throttle: stay running so the client paces and retries the same cursor.
    const u = await saveJob(
      admin,
      jobId,
      throttled
        ? { last_error: "Throttled by Shopify; retrying…" }
        : { status: "failed", last_error: body.errors.map((e) => e.message).join("; ") },
    )
    return { ok: true, job: toProgress(u) }
  }

  const ordersPage = body.data?.orders
  let { fetched, imported, duplicates, needs_mapping, skipped } = job
  let firstError = job.first_error
  for (const node of ordersPage?.nodes ?? []) {
    fetched++
    const order = normalizeGraphqlOrder(node)
    const outcome = await importNormalizedOrder(
      admin,
      siteId,
      shopDomain,
      order,
      "orders/backfill",
      node,
    )
    switch (outcome.status) {
      case "imported":
        imported++
        break
      case "duplicate":
        duplicates++
        break
      case "needs_mapping":
        needs_mapping++
        if (!firstError)
          firstError = `Order ${order.name ?? order.shopifyOrderId} has unmapped variants — sync products first.`
        break
      case "skipped":
        skipped++
        break
      case "error":
        skipped++
        if (!firstError) firstError = outcome.error
        break
    }
  }

  const hasNext = Boolean(
    ordersPage?.pageInfo?.hasNextPage && ordersPage?.pageInfo?.endCursor,
  )
  const patch: Record<string, unknown> = {
    fetched,
    imported,
    duplicates,
    needs_mapping,
    skipped,
    first_error: firstError,
    last_error: null,
    page_count: job.page_count + 1,
    cursor: hasNext ? ordersPage!.pageInfo.endCursor : job.cursor,
  }
  if (!hasNext) {
    patch.status = "completed"
    patch.finished_at = new Date().toISOString()
  }
  const updated = await saveJob(admin, jobId, patch)
  if (!hasNext) {
    revalidatePath("/integrations/shopify")
    revalidatePath("/orders")
  }
  return { ok: true, job: toProgress(updated) }
}
