"use server"

import { revalidatePath } from "next/cache"
import { headers } from "next/headers"

import { createClient } from "@/lib/supabase/server"
import { importShopifyProduct } from "@/lib/shopify/import-products"
import type { ShopifyProduct } from "@/lib/shopify/types"

const SHOPIFY_API_VERSION = "2024-10"

export type ActionResult = { ok: true } | { ok: false; error: string }
export type SyncResult =
  | { ok: true; products: number; created: number; updated: number; skipped: number }
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
    .from("shopify_connections")
    .insert({ shop_domain: domain, site_id: siteId })
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
    .from("shopify_connections")
    .update({ is_active: isActive })
    .eq("id", id)
  if (error) return { ok: false, error: err(error) }

  revalidatePath("/integrations/shopify")
  return { ok: true }
}

export async function deleteConnection(id: string): Promise<ActionResult> {
  const supabase = await createClient()
  const { error } = await supabase
    .from("shopify_connections")
    .delete()
    .eq("id", id)
  if (error) return { ok: false, error: err(error) }

  revalidatePath("/integrations/shopify")
  return { ok: true }
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

  // Merge with any existing values so a blank field keeps the current one.
  const { data: existing } = await supabase
    .from("shopify_secrets")
    .select("access_token, api_secret")
    .eq("connection_id", connectionId)
    .maybeSingle()

  const { error } = await supabase.from("shopify_secrets").upsert(
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
 * Backfill: pull every product from the connected store via the Admin API and
 * upsert each variant into the catalog. Runs server-side with the store's token
 * (which never leaves the server). Ongoing changes arrive via product webhooks.
 */
export async function syncProducts(connectionId: string): Promise<SyncResult> {
  const supabase = await createClient()

  const { data: conn, error: connErr } = await supabase
    .from("shopify_connections")
    .select("shop_domain, site_id")
    .eq("id", connectionId)
    .maybeSingle()
  if (connErr) return { ok: false, error: err(connErr) }
  if (!conn) return { ok: false, error: "Connection not found." }

  const { data: secret } = await supabase
    .from("shopify_secrets")
    .select("access_token")
    .eq("connection_id", connectionId)
    .maybeSingle()
  if (!secret?.access_token) {
    return {
      ok: false,
      error: "Set this store's Admin API access token first.",
    }
  }

  const totals = { products: 0, created: 0, updated: 0, skipped: 0 }
  let url: string | null =
    `https://${conn.shop_domain}/admin/api/${SHOPIFY_API_VERSION}/products.json?limit=250`

  try {
    for (let page = 0; url && page < 40; page++) {
      const r: Response = await fetch(url, {
        headers: {
          "X-Shopify-Access-Token": secret.access_token,
          "Content-Type": "application/json",
        },
      })
      if (!r.ok) {
        return {
          ok: false,
          error: `Shopify API returned ${r.status}. Check the store domain and token.`,
        }
      }
      const body = (await r.json()) as { products?: ShopifyProduct[] }
      for (const product of body.products ?? []) {
        const res = await importShopifyProduct(
          supabase,
          conn.site_id as string,
          product,
        )
        totals.products++
        totals.created += res.created
        totals.updated += res.updated
        totals.skipped += res.skipped
      }
      url = nextPageUrl(r.headers.get("link"))
    }
  } catch {
    return { ok: false, error: "Could not reach Shopify. Try again." }
  }

  await supabase
    .from("shopify_connections")
    .update({ last_synced_at: new Date().toISOString() })
    .eq("id", connectionId)

  revalidatePath("/integrations/shopify")
  revalidatePath("/catalog")
  return { ok: true, ...totals }
}

export type RegisterResult =
  | { ok: true; created: number; existing: number; failed: number }
  | { ok: false; error: string }

const WEBHOOK_TOPICS = [
  "orders/create",
  "products/create",
  "products/update",
  "products/delete",
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
    .from("shopify_connections")
    .select("shop_domain")
    .eq("id", connectionId)
    .maybeSingle()
  if (!conn) return { ok: false, error: "Connection not found." }

  const { data: secret } = await supabase
    .from("shopify_secrets")
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
        `https://${conn.shop_domain}/admin/api/${SHOPIFY_API_VERSION}/webhooks.json`,
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
