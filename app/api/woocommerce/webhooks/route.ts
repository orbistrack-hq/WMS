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
// Orders
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

  // Idempotency: a Woo retry hits the unique (channel, source, order_id) key.
  const { data: importRow, error: insErr } = await supabase
    .from("store_order_imports")
    .insert({
      channel: "woocommerce",
      source,
      external_order_id: order.externalOrderId,
      topic,
      status: "received",
      payload,
    })
    .select("id")
    .single()

  if (insErr) {
    if (insErr.code === "23505") {
      return NextResponse.json({ ok: true, duplicate: true }, { status: 200 })
    }
    return NextResponse.json({ error: insErr.message }, { status: 500 })
  }

  const importId = importRow.id as string
  const finish = (
    status: string,
    extra: { error?: string; wms_order_id?: string } = {},
  ) =>
    supabase
      .from("store_order_imports")
      .update({ status, processed_at: new Date().toISOString(), ...extra })
      .eq("id", importId)

  const siteId = await siteForSource(supabase, source)
  if (!siteId) {
    await finish("error", { error: `No active connection for ${source}` })
    return NextResponse.json({ ok: true, status: "no_connection" })
  }

  if (order.lines.length === 0) {
    await finish("error", { error: "Order has no mappable line items" })
    return NextResponse.json({ ok: true, status: "empty" })
  }

  // Map Woo product/variation ids -> child SKUs at this site.
  const variantIds = order.lines
    .map((l) => l.variantId)
    .filter((v): v is string => Boolean(v))
  const { data: skus } = await supabase
    .from("child_skus")
    .select("id, store_variant_id")
    .eq("site_id", siteId)
    .eq("is_active", true)
    .in("store_variant_id", variantIds)
  const skuByVariant = new Map(
    (skus ?? []).map((s) => [s.store_variant_id as string, s.id as string]),
  )

  const mappedLines: {
    child_sku_id: string
    quantity: number
    unit_price: number | null
  }[] = []
  const unmapped: string[] = []
  for (const line of order.lines) {
    const childSkuId = line.variantId
      ? skuByVariant.get(line.variantId)
      : undefined
    if (!childSkuId) {
      unmapped.push(line.variantId ?? line.title ?? "unknown")
      continue
    }
    mappedLines.push({
      child_sku_id: childSkuId,
      quantity: line.quantity,
      unit_price: line.unitPrice,
    })
  }

  if (unmapped.length > 0) {
    await finish("needs_mapping", {
      error: `Unmapped WooCommerce items: ${unmapped.join(", ")}. Sync products (variable products need a sync to map their variations), then re-send.`,
    })
    return NextResponse.json({ ok: true, status: "needs_mapping", unmapped })
  }

  // Resolve / create the customer (by email).
  let customerId: string | null = null
  if (order.customer?.email) {
    const email = order.customer.email
    const { data: existing } = await supabase
      .from("customers")
      .select("id")
      .ilike("email", email)
      .limit(1)
      .maybeSingle()
    if (existing) {
      customerId = existing.id as string
    } else {
      const { data: created } = await supabase
        .from("customers")
        .insert({
          name: order.customer.name,
          email,
          external_ref: order.customer.externalId
            ? { woocommerce_customer_id: order.customer.externalId }
            : null,
        })
        .select("id")
        .single()
      customerId = created?.id ?? null
    }
  }

  const label = order.number ?? order.externalOrderId
  const { data: newOrderId, error: createErr } = await supabase.rpc(
    "create_order",
    {
      p_site_id: siteId,
      p_lines: mappedLines,
      p_customer_id: customerId,
      p_channel: "woocommerce",
      p_order_type: "standard",
      p_ship_to_name: order.shipTo?.name ?? null,
      p_ship_to_address1: order.shipTo?.address1 ?? null,
      p_ship_to_address2: order.shipTo?.address2 ?? null,
      p_ship_to_city: order.shipTo?.city ?? null,
      p_ship_to_region: order.shipTo?.region ?? null,
      p_ship_to_postal: order.shipTo?.postal ?? null,
      p_ship_to_country: order.shipTo?.country ?? null,
      p_notes: order.note
        ? `WooCommerce #${label}: ${order.note}`
        : `Imported from WooCommerce #${label}`,
    },
  )

  if (createErr) {
    await finish("error", { error: createErr.message })
    return NextResponse.json({
      ok: true,
      status: "error",
      error: createErr.message,
    })
  }

  await finish("imported", { wms_order_id: newOrderId as string })
  return NextResponse.json({ ok: true, status: "imported", orderId: newOrderId })
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
