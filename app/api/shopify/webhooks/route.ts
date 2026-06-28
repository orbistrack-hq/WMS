import { NextResponse } from "next/server"
import type { SupabaseClient } from "@supabase/supabase-js"

import { createAdminClient } from "@/lib/supabase/admin"
import {
  normalizeShopifyOrder,
  verifyShopifyHmac,
  type ShopifyOrderPayload,
  type ShopifyProduct,
} from "@/lib/shopify/types"
import {
  importShopifyProduct,
  deactivateShopifyProduct,
} from "@/lib/shopify/import-products"
import { applyShopifyOrderMeta } from "@/lib/shopify/import-orders"

// HMAC verification + the service-role client need the Node runtime.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(req: Request) {
  const raw = await req.text()
  const hmac = req.headers.get("x-shopify-hmac-sha256")
  const topic = req.headers.get("x-shopify-topic") ?? ""
  const shopDomain = req.headers.get("x-shopify-shop-domain") ?? ""

  const supabase = createAdminClient()

  // Authenticate per-store: verify the HMAC against THIS store's own API secret
  // (entered by the client). Falls back to a global env secret if one is set.
  const { data: connRow } = await supabase
    .from("shopify_connections")
    .select("secret:shopify_secrets(api_secret)")
    .eq("shop_domain", shopDomain)
    .eq("is_active", true)
    .maybeSingle()
  const embed = (connRow as { secret?: unknown } | null)?.secret
  const storeSecret = (
    Array.isArray(embed) ? embed[0] : embed
  ) as { api_secret?: string | null } | null | undefined
  const secret = storeSecret?.api_secret ?? process.env.SHOPIFY_WEBHOOK_SECRET

  if (!verifyShopifyHmac(raw, hmac, secret ?? undefined)) {
    return NextResponse.json({ error: "invalid hmac" }, { status: 401 })
  }

  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 })
  }

  switch (topic) {
    case "orders/create":
      return handleOrderCreate(
        supabase,
        shopDomain,
        topic,
        payload as ShopifyOrderPayload,
      )
    case "products/create":
    case "products/update":
      return handleProductUpsert(supabase, shopDomain, payload as ShopifyProduct)
    case "products/delete":
      return handleProductDelete(supabase, shopDomain, payload as ShopifyProduct)
    default:
      return NextResponse.json({ ok: true, ignored: topic }, { status: 200 })
  }
}

/** The active WMS site a store feeds, or null if not connected. */
async function siteForShop(
  supabase: SupabaseClient,
  shopDomain: string,
): Promise<string | null> {
  const { data } = await supabase
    .from("shopify_connections")
    .select("site_id")
    .eq("shop_domain", shopDomain)
    .eq("is_active", true)
    .maybeSingle()
  return (data?.site_id as string) ?? null
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------
async function handleOrderCreate(
  supabase: SupabaseClient,
  shopDomain: string,
  topic: string,
  payload: ShopifyOrderPayload,
) {
  const order = normalizeShopifyOrder(payload)
  if (!order.shopifyOrderId) {
    return NextResponse.json({ error: "missing order id" }, { status: 400 })
  }

  // Idempotency: a Shopify retry hits the unique (shop_domain, order_id) key.
  const { data: importRow, error: insErr } = await supabase
    .from("shopify_order_imports")
    .insert({
      shop_domain: shopDomain,
      shopify_order_id: order.shopifyOrderId,
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
      .from("shopify_order_imports")
      .update({ status, processed_at: new Date().toISOString(), ...extra })
      .eq("id", importId)

  const siteId = await siteForShop(supabase, shopDomain)
  if (!siteId) {
    await finish("error", { error: `No active connection for ${shopDomain}` })
    return NextResponse.json({ ok: true, status: "no_connection" })
  }

  if (order.lines.length === 0) {
    await finish("error", { error: "Order has no mappable line items" })
    return NextResponse.json({ ok: true, status: "empty" })
  }

  // Map Shopify variant IDs -> child SKUs at this site.
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
      error: `Unmapped Shopify variants: ${unmapped.join(", ")}. Sync products or set store_variant_id, then re-send.`,
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
            ? { shopify_customer_id: order.customer.externalId }
            : null,
        })
        .select("id")
        .single()
      customerId = created?.id ?? null
    }
  }

  const { data: newOrderId, error: createErr } = await supabase.rpc(
    "create_order",
    {
      p_site_id: siteId,
      p_lines: mappedLines,
      p_customer_id: customerId,
      p_channel: "shopify",
      p_order_type: "standard",
      p_ship_to_name: order.shipTo?.name ?? null,
      p_ship_to_address1: order.shipTo?.address1 ?? null,
      p_ship_to_address2: order.shipTo?.address2 ?? null,
      p_ship_to_city: order.shipTo?.city ?? null,
      p_ship_to_region: order.shipTo?.region ?? null,
      p_ship_to_postal: order.shipTo?.postal ?? null,
      p_ship_to_country: order.shipTo?.country ?? null,
      p_notes: order.note
        ? `Shopify ${order.name ?? order.shopifyOrderId}: ${order.note}`
        : `Imported from Shopify ${order.name ?? order.shopifyOrderId}`,
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

  // Stamp the Shopify order number and reflect its fulfilled/cancelled state.
  await applyShopifyOrderMeta(supabase, newOrderId as string, order)

  await finish("imported", { wms_order_id: newOrderId as string })
  return NextResponse.json({ ok: true, status: "imported", orderId: newOrderId })
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------
async function handleProductUpsert(
  supabase: SupabaseClient,
  shopDomain: string,
  product: ShopifyProduct,
) {
  const siteId = await siteForShop(supabase, shopDomain)
  if (!siteId) {
    return NextResponse.json({ ok: true, status: "no_connection" })
  }
  const result = await importShopifyProduct(supabase, siteId, product)
  return NextResponse.json({ ok: true, status: "synced", ...result })
}

async function handleProductDelete(
  supabase: SupabaseClient,
  shopDomain: string,
  product: ShopifyProduct,
) {
  const siteId = await siteForShop(supabase, shopDomain)
  if (!siteId) {
    return NextResponse.json({ ok: true, status: "no_connection" })
  }
  // products/delete usually carries only the id; deactivate when variants are
  // present, otherwise ack (the SKU can be deactivated manually in Catalog).
  const deactivated = await deactivateShopifyProduct(supabase, siteId, product)
  return NextResponse.json({ ok: true, status: "deleted", deactivated })
}
