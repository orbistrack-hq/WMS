import { NextResponse } from "next/server"

import { createAdminClient } from "@/lib/supabase/admin"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Read-only store-connection diagnostic (temporary — delete after debugging).
 *
 *   GET /api/store-sync/connections
 *
 * Lists every store_connection with its stored `source` and WHICH secret fields
 * are populated — as booleans only, never the values. Use it to debug 401s:
 *
 *  - The webhook receivers look up the per-store secret by matching the incoming
 *    source header EXACTLY against store_connections.source
 *    (Shopify: the x-shopify-shop-domain, e.g. "mystore.myshopify.com", no
 *    scheme; Woo: the site URL normalized to "https://host"). If the stored
 *    `source` here doesn't match what the store actually sends, no per-store
 *    secret is found, it falls back to the (empty) env var, and every delivery
 *    401s — even though your secret "is set".
 *  - hasWebhookSecret / hasApiSecret being false means the signing secret the
 *    receiver verifies against isn't stored on that connection.
 */
export async function GET() {
  const admin = createAdminClient()
  const { data, error } = await admin
    .from("store_connections")
    .select(
      "channel, source, is_active, site:sites(name), secret:store_secrets(webhook_secret, api_secret, access_token, consumer_key, consumer_secret)",
    )
    .order("channel")

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const has = (v: unknown) => typeof v === "string" && v.trim().length > 0

  const rows = (data ?? []).map((c) => {
    const embed = (c as { secret?: unknown }).secret
    const s = (Array.isArray(embed) ? embed[0] : embed) as
      | Record<string, string | null>
      | null
      | undefined
    const site = (c as { site?: { name?: string | null } | null }).site
    return {
      channel: (c as { channel: string }).channel,
      source: (c as { source: string }).source,
      site: site?.name ?? null,
      isActive: (c as { is_active: boolean }).is_active,
      // Woo verifies inbound webhooks against webhook_secret; Shopify against
      // api_secret. The rest are for outbound pushes.
      hasWebhookSecret: has(s?.webhook_secret),
      hasApiSecret: has(s?.api_secret),
      hasAccessToken: has(s?.access_token),
      hasConsumerKey: has(s?.consumer_key),
      hasConsumerSecret: has(s?.consumer_secret),
    }
  })

  return NextResponse.json({ count: rows.length, connections: rows })
}
