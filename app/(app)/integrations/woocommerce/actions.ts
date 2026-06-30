"use server"

import { revalidatePath } from "next/cache"
import { headers } from "next/headers"

import { createClient } from "@/lib/supabase/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { importWooProduct } from "@/lib/woocommerce/import-products"
import { importWooOrder } from "@/lib/woocommerce/import-orders"
import {
  normalizeWooOrder,
  normalizeWooSource,
  type WooOrderPayload,
  type WooProduct,
  type WooVariation,
} from "@/lib/woocommerce/types"

export type ActionResult = { ok: true } | { ok: false; error: string }
export type SyncResult =
  | {
      ok: true
      products: number
      created: number
      updated: number
      skipped: number
      stockSynced: number
      costSeeded: number
      warning?: string
    }
  | { ok: false; error: string }

export type OrderSyncResult =
  | {
      ok: true
      fetched: number
      imported: number
      duplicates: number
      needsMapping: number
      skipped: number
      warning?: string
    }
  | { ok: false; error: string }

type PgError = { message?: string; details?: string; code?: string } | null

function err(error: PgError): string {
  if (!error) return "Something went wrong."
  if (error.code === "42501")
    return "You don't have access to that site."
  if (error.code === "23505") return "That store is already connected."
  return error.message || error.details || "Something went wrong."
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------
export async function createConnection(
  storeUrl: string,
  siteId: string,
): Promise<ActionResult> {
  const source = normalizeWooSource(storeUrl)
  if (!source) return { ok: false, error: "Enter the store's URL (https://…)." }
  if (!siteId) return { ok: false, error: "Pick the WMS site this store feeds." }

  const supabase = await createClient()
  const { error } = await supabase
    .from("store_connections")
    .insert({ channel: "woocommerce", source, site_id: siteId })
  if (error) return { ok: false, error: err(error) }

  revalidatePath("/integrations/woocommerce")
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

  revalidatePath("/integrations/woocommerce")
  return { ok: true }
}

export async function deleteConnection(id: string): Promise<ActionResult> {
  const supabase = await createClient()
  const { error } = await supabase
    .from("store_connections")
    .delete()
    .eq("id", id)
  if (error) return { ok: false, error: err(error) }

  revalidatePath("/integrations/woocommerce")
  return { ok: true }
}

/**
 * Store/replace a store's credentials. Blank fields are left unchanged, so the
 * client can update one without re-entering the others. The connection select
 * (user client, RLS) authorizes the caller; the sealed store_secrets table is
 * written only with the service role.
 */
export async function setCredentials(
  connectionId: string,
  consumerKey: string,
  consumerSecret: string,
  webhookSecret: string,
): Promise<ActionResult> {
  const ck = consumerKey.trim()
  const cs = consumerSecret.trim()
  const ws = webhookSecret.trim()
  if (!ck && !cs && !ws)
    return { ok: false, error: "Enter at least one credential." }

  const supabase = await createClient()
  const { data: conn } = await supabase
    .from("store_connections")
    .select("id")
    .eq("id", connectionId)
    .maybeSingle()
  if (!conn) return { ok: false, error: "Connection not found or access denied." }

  const admin = createAdminClient()
  const { data: existing } = await admin
    .from("store_secrets")
    .select("consumer_key, consumer_secret, webhook_secret")
    .eq("connection_id", connectionId)
    .maybeSingle()

  const { error } = await admin.from("store_secrets").upsert(
    {
      connection_id: connectionId,
      consumer_key: ck || existing?.consumer_key || null,
      consumer_secret: cs || existing?.consumer_secret || null,
      webhook_secret: ws || existing?.webhook_secret || null,
    },
    { onConflict: "connection_id" },
  )
  if (error) return { ok: false, error: err(error) }

  revalidatePath("/integrations/woocommerce")
  return { ok: true }
}

// ---------------------------------------------------------------------------
// WooCommerce REST helpers
// ---------------------------------------------------------------------------
function authHeader(consumerKey: string, consumerSecret: string): string {
  const token = Buffer.from(`${consumerKey}:${consumerSecret}`).toString(
    "base64",
  )
  return `Basic ${token}`
}

function wooApiError(status: number, body: string): string {
  let detail = ""
  try {
    const j = JSON.parse(body)
    detail = typeof j?.message === "string" ? j.message : ""
  } catch {
    detail = body.slice(0, 200)
  }
  const hint =
    status === 401
      ? " Check the consumer key/secret and that the key has Read/Write access."
      : status === 404
        ? " Check the store URL and that the WooCommerce REST API is enabled (pretty permalinks on)."
        : ""
  return `WooCommerce API ${status}${detail ? `: ${detail}` : ""}.${hint}`
}

type WooCreds = { source: string; site_id: string; key: string; secret: string }

/** Load a connection's source/site + its REST credentials (admin read). */
async function loadCreds(
  connectionId: string,
): Promise<{ creds?: WooCreds; error?: string }> {
  const supabase = await createClient()
  const { data: conn, error: connErr } = await supabase
    .from("store_connections")
    .select("source, site_id")
    .eq("id", connectionId)
    .maybeSingle()
  if (connErr) return { error: err(connErr) }
  if (!conn) return { error: "Connection not found." }

  const { data: secret } = await createAdminClient()
    .from("store_secrets")
    .select("consumer_key, consumer_secret")
    .eq("connection_id", connectionId)
    .maybeSingle()
  if (!secret?.consumer_key || !secret?.consumer_secret) {
    return { error: "Set this store's consumer key and secret first." }
  }
  return {
    creds: {
      source: conn.source as string,
      site_id: conn.site_id as string,
      key: secret.consumer_key as string,
      secret: secret.consumer_secret as string,
    },
  }
}

/**
 * Backfill: pull every product from the connected store via the Woo REST API
 * and upsert each (simple product or each variation of a variable product) into
 * the catalog, with price and stock. Cost is never pulled (Woo has none).
 */
export async function syncProducts(connectionId: string): Promise<SyncResult> {
  const { creds, error: credErr } = await loadCreds(connectionId)
  if (!creds) return { ok: false, error: credErr ?? "Missing credentials." }
  const base = `${creds.source}/wp-json/wc/v3`
  const auth = { Authorization: authHeader(creds.key, creds.secret) }
  const supabase = await createClient()

  const totals = {
    products: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    stockSynced: 0,
    costSeeded: 0,
  }
  let firstError: string | undefined

  try {
    for (let page = 1; page <= 50; page++) {
      const r: Response = await fetch(
        `${base}/products?per_page=100&page=${page}`,
        { headers: auth },
      )
      if (!r.ok) {
        const raw = await r.text().catch(() => "")
        return { ok: false, error: wooApiError(r.status, raw) }
      }
      const products = (await r.json()) as WooProduct[]
      if (!Array.isArray(products) || products.length === 0) break

      for (const product of products) {
        // Variable products: pull their variations so each maps as a child SKU.
        let variations: WooVariation[] | undefined
        if ((product.type ?? "").toLowerCase() === "variable" && product.id != null) {
          variations = []
          for (let vp = 1; vp <= 20; vp++) {
            const vr: Response = await fetch(
              `${base}/products/${product.id}/variations?per_page=100&page=${vp}`,
              { headers: auth },
            )
            if (!vr.ok) break
            const batch = (await vr.json()) as WooVariation[]
            if (!Array.isArray(batch) || batch.length === 0) break
            variations.push(...batch)
            if (batch.length < 100) break
          }
        }

        const res = await importWooProduct(supabase, creds.site_id, product, {
          variations,
          syncInventory: true,
        })
        totals.products++
        totals.created += res.created
        totals.updated += res.updated
        totals.skipped += res.skipped
        totals.stockSynced += res.stockSynced
        totals.costSeeded += res.costSeeded
        if (!firstError && res.firstError) firstError = res.firstError
      }

      if (products.length < 100) break
    }
  } catch {
    return { ok: false, error: "Could not reach WooCommerce. Try again." }
  }

  if (totals.created === 0 && totals.updated === 0 && totals.skipped > 0) {
    return {
      ok: false,
      error: `All ${totals.skipped} items were skipped — the catalog write is failing${firstError ? `: ${firstError}` : "."}`,
    }
  }

  await supabase
    .from("store_connections")
    .update({ last_synced_at: new Date().toISOString() })
    .eq("id", connectionId)

  revalidatePath("/integrations/woocommerce")
  revalidatePath("/catalog")
  revalidatePath("/inventory")
  return { ok: true, ...totals }
}

export type RegisterResult =
  | { ok: true; created: number; existing: number; failed: number }
  | { ok: false; error: string }

const WEBHOOK_TOPICS = [
  "order.created",
  "product.created",
  "product.updated",
  "product.deleted",
]

/**
 * Register the WMS webhook endpoint on the store via the Woo REST API, signed
 * with the stored webhook secret. Skips topics already pointed at our endpoint
 * so re-running doesn't create duplicates.
 */
export async function registerWebhooks(
  connectionId: string,
): Promise<RegisterResult> {
  const { creds, error: credErr } = await loadCreds(connectionId)
  if (!creds) return { ok: false, error: credErr ?? "Missing credentials." }

  // The webhook secret must be set so deliveries can be verified.
  const { data: secretRow } = await createAdminClient()
    .from("store_secrets")
    .select("webhook_secret")
    .eq("connection_id", connectionId)
    .maybeSingle()
  const webhookSecret = secretRow?.webhook_secret as string | null | undefined
  if (!webhookSecret) {
    return { ok: false, error: "Set a webhook secret for this store first." }
  }

  const h = await headers()
  const host = h.get("host")
  if (!host) return { ok: false, error: "Could not determine the callback URL." }
  const proto = host.startsWith("localhost") ? "http" : "https"
  const deliveryUrl = `${proto}://${host}/api/woocommerce/webhooks`

  const base = `${creds.source}/wp-json/wc/v3`
  const auth = {
    Authorization: authHeader(creds.key, creds.secret),
    "Content-Type": "application/json",
  }

  const result = { created: 0, existing: 0, failed: 0 }
  try {
    // Existing webhooks pointing at our endpoint, so we don't duplicate.
    const existingTopics = new Set<string>()
    const er = await fetch(`${base}/webhooks?per_page=100`, {
      headers: { Authorization: authHeader(creds.key, creds.secret) },
    })
    if (er.ok) {
      const hooks = (await er.json()) as {
        topic?: string
        delivery_url?: string
      }[]
      for (const w of Array.isArray(hooks) ? hooks : []) {
        if (w.delivery_url === deliveryUrl && w.topic) existingTopics.add(w.topic)
      }
    }

    for (const topic of WEBHOOK_TOPICS) {
      if (existingTopics.has(topic)) {
        result.existing++
        continue
      }
      const r = await fetch(`${base}/webhooks`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          name: `WMS ${topic}`,
          topic,
          delivery_url: deliveryUrl,
          secret: webhookSecret,
          status: "active",
        }),
      })
      if (r.status === 201) result.created++
      else result.failed++
    }
  } catch {
    return { ok: false, error: "Could not reach WooCommerce. Try again." }
  }

  revalidatePath("/integrations/woocommerce")
  return { ok: true, ...result }
}

/**
 * Backfill: page through the store's historical orders via the Woo REST API and
 * import each into WMS (idempotent — re-running skips orders already imported).
 * Each order is backdated to its original Woo date, and completed/cancelled
 * orders land in that lifecycle (so historical orders don't sit open). Newest
 * first. Ongoing orders still arrive through the order webhook.
 */
export async function syncPastOrders(
  connectionId: string,
): Promise<OrderSyncResult> {
  const { creds, error: credErr } = await loadCreds(connectionId)
  if (!creds) return { ok: false, error: credErr ?? "Missing credentials." }
  const base = `${creds.source}/wp-json/wc/v3`
  const auth = { Authorization: authHeader(creds.key, creds.secret) }

  // Imports use the service role: store_order_imports has no RLS write policy.
  const admin = createAdminClient()

  const result = {
    fetched: 0,
    imported: 0,
    duplicates: 0,
    needsMapping: 0,
    skipped: 0,
  }
  let firstError: string | undefined

  try {
    for (let page = 1; page <= 100; page++) {
      const r: Response = await fetch(
        `${base}/orders?per_page=100&page=${page}&orderby=date&order=desc`,
        { headers: auth },
      )
      if (!r.ok) {
        const raw = await r.text().catch(() => "")
        return { ok: false, error: wooApiError(r.status, raw) }
      }
      const orders = (await r.json()) as WooOrderPayload[]
      if (!Array.isArray(orders) || orders.length === 0) break

      for (const raw of orders) {
        result.fetched++
        const order = normalizeWooOrder(raw)
        const outcome = await importWooOrder(
          admin,
          creds.site_id,
          creds.source,
          order,
          "order.backfill",
          raw,
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
              firstError = `Order #${order.number ?? order.externalOrderId} has unmapped items — sync products first.`
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

      if (orders.length < 100) break
    }
  } catch {
    return { ok: false, error: "Could not reach WooCommerce. Try again." }
  }

  revalidatePath("/integrations/woocommerce")
  revalidatePath("/orders")
  revalidatePath("/inventory")

  const warning =
    result.needsMapping > 0
      ? `${result.needsMapping} order(s) reference items not in the catalog — run "Sync products" first, then re-run.${firstError ? ` (${firstError})` : ""}`
      : undefined
  return { ok: true, ...result, warning }
}
