import { NextResponse } from "next/server"
import type { SupabaseClient } from "@supabase/supabase-js"

import { createAdminClient } from "@/lib/supabase/admin"
import {
  normalizeWooOrder,
  normalizeWooSource,
  verifyWooSignature,
  type WooOrderPayload,
  type WooProduct,
} from "@/lib/woocommerce/types"
import {
  importWooProduct,
  deactivateWooProduct,
} from "@/lib/woocommerce/import-products"
import { importWooOrder } from "@/lib/woocommerce/import-orders"

// HMAC verification + the service-role client need the Node runtime.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(req: Request) {
  const raw = await req.text()
  const signature = req.headers.get("x-wc-webhook-signature")
  const topic = req.headers.get("x-wc-webhook-topic") ?? ""
  const source = normalizeWooSource(
    req.headers.get("x-wc-webhook-source") ?? "",
  )

  const supabase = createAdminClient()

  // Authenticate per-store: verify the signature against THIS store's own
  // webhook secret (entered by the client). Falls back to a global env secret.
  const { data: connRow } = await supabase
    .from("store_connections")
    .select("secret:store_secrets(webhook_secret)")
    .eq("channel", "woocommerce")
    .eq("source", source)
    .eq("is_active", true)
    .maybeSingle()
  const embed = (connRow as { secret?: unknown } | null)?.secret
  const storeSecret = (Array.isArray(embed) ? embed[0] : embed) as
    | { webhook_secret?: string | null }
    | null
    | undefined
  const secret =
    storeSecret?.webhook_secret ?? process.env.WOOCOMMERCE_WEBHOOK_SECRET

  if (!verifyWooSignature(raw, signature, secret ?? undefined)) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 })
  }

  // Woo sends a non-JSON ping ("webhook_id=...") when a webhook is first saved.
  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    return NextResponse.json({ ok: true, ignored: "non-json ping" })
  }

  switch (topic) {
    case "order.created":
    case "order.updated":
      return handleOrderCreate(
        supabase,
        source,
        topic,
        payload as WooOrderPayload,
      )
    case "product.created":
    case "product.updated":
      return handleProductUpsert(supabase, source, payload as WooProduct)
    case "product.deleted":
      return handleProductDelete(supabase, source, payload as WooProduct)
    default:
      return NextResponse.json({ ok: true, ignored: topic }, { status: 200 })
  }
}

/** The active WMS site a store feeds, or null if not connected. */
async function siteForSource(
  supabase: SupabaseClient,
  source: string,
): Promise<string | null> {
  const { data } = await supabase
    .from("store_connections")
    .select("site_id")
    .eq("channel", "woocommerce")
    .eq("source", source)
    .eq("is_active", true)
    .maybeSingle()
  return (data?.site_id as string) ?? null
}

// ---------------------------------------------------------------------------
// Orders — delegates to the shared importWooOrder so the live webhook and the
// past-orders backfill behave identically (idempotency, mapping, backdating,
// completed/cancelled lifecycle).
// ---------------------------------------------------------------------------
async function handleOrderCreate(
  supabase: SupabaseClient,
  source: string,
  topic: string,
  payload: WooOrderPayload,
) {
  const order = normalizeWooOrder(payload)
  if (!order.externalOrderId) {
    return NextResponse.json({ error: "missing order id" }, { status: 400 })
  }

  const siteId = await siteForSource(supabase, source)
  if (!siteId) {
    return NextResponse.json({ ok: true, status: "no_connection" })
  }

  const outcome = await importWooOrder(
    supabase,
    siteId,
    source,
    order,
    topic,
    payload,
  )
  return NextResponse.json({ ok: true, ...outcome })
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------
async function handleProductUpsert(
  supabase: SupabaseClient,
  source: string,
  product: WooProduct,
) {
  const siteId = await siteForSource(supabase, source)
  if (!siteId) {
    return NextResponse.json({ ok: true, status: "no_connection" })
  }
  const result = await importWooProduct(supabase, siteId, product)
  return NextResponse.json({ ok: true, status: "synced", ...result })
}

async function handleProductDelete(
  supabase: SupabaseClient,
  source: string,
  product: WooProduct,
) {
  const siteId = await siteForSource(supabase, source)
  if (!siteId) {
    return NextResponse.json({ ok: true, status: "no_connection" })
  }
  const deactivated = await deactivateWooProduct(supabase, siteId, product)
  return NextResponse.json({ ok: true, status: "deleted", deactivated })
}
