import type { SupabaseClient } from "@supabase/supabase-js"

import type { NormalizedShopifyOrder } from "./types"

export type OrderImportOutcome =
  | { status: "imported"; wmsOrderId: string }
  | { status: "duplicate" }
  | { status: "needs_mapping"; unmapped: string[] }
  | { status: "skipped"; reason: string }
  | { status: "error"; error: string }

/**
 * Import one normalized Shopify order into WMS. Shared by the orders/create
 * webhook and the past-orders backfill so both behave identically:
 *
 *  - idempotent on (shop_domain, shopify_order_id) via shopify_order_imports
 *  - maps Shopify variant ids -> child SKUs at the order's site
 *  - resolves/creates the customer by email
 *  - writes the order through the guarded create_order RPC
 *
 * Unlike the webhook, this backdates the WMS order to the original Shopify
 * created_at (sale_date + entered_at) so historical orders keep their real date.
 *
 * Must be called with a service-role client: it writes shopify_order_imports
 * (no RLS write policy) and reads across customers/child_skus.
 */
export async function importNormalizedOrder(
  client: SupabaseClient,
  siteId: string,
  shopDomain: string,
  order: NormalizedShopifyOrder,
  topic: string,
  rawPayload: unknown,
): Promise<OrderImportOutcome> {
  if (!order.shopifyOrderId) {
    return { status: "error", error: "missing order id" }
  }

  // Idempotency: a re-run (or Shopify retry) hits the unique key and is skipped.
  const { data: importRow, error: insErr } = await client
    .from("shopify_order_imports")
    .insert({
      shop_domain: shopDomain,
      shopify_order_id: order.shopifyOrderId,
      topic,
      status: "received",
      payload: rawPayload,
    })
    .select("id")
    .single()

  if (insErr) {
    if (insErr.code === "23505") return { status: "duplicate" }
    return { status: "error", error: insErr.message }
  }

  const importId = importRow.id as string
  const finish = (
    status: string,
    extra: { error?: string; wms_order_id?: string } = {},
  ) =>
    client
      .from("shopify_order_imports")
      .update({ status, processed_at: new Date().toISOString(), ...extra })
      .eq("id", importId)

  if (order.lines.length === 0) {
    await finish("error", { error: "Order has no mappable line items" })
    return { status: "skipped", reason: "empty" }
  }

  // Map Shopify variant ids -> child SKUs at this site.
  const variantIds = order.lines
    .map((l) => l.variantId)
    .filter((v): v is string => Boolean(v))
  const { data: skus } = await client
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
      error: `Unmapped Shopify variants: ${unmapped.join(", ")}. Sync products or set store_variant_id, then re-run.`,
    })
    return { status: "needs_mapping", unmapped }
  }

  // Resolve / create the customer (by email).
  let customerId: string | null = null
  if (order.customer?.email) {
    const email = order.customer.email
    const { data: existing } = await client
      .from("customers")
      .select("id")
      .ilike("email", email)
      .limit(1)
      .maybeSingle()
    if (existing) {
      customerId = existing.id as string
    } else {
      const { data: created } = await client
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

  // Backdate to the original Shopify order time when present.
  const saleDate = order.createdAt ? order.createdAt.slice(0, 10) : null

  const { data: newOrderId, error: createErr } = await client.rpc(
    "create_order",
    {
      p_site_id: siteId,
      p_lines: mappedLines,
      p_customer_id: customerId,
      p_channel: "shopify",
      p_order_type: "standard",
      p_sale_date: saleDate,
      p_entered_at: order.createdAt ?? null,
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
    return { status: "error", error: createErr.message }
  }

  await finish("imported", { wms_order_id: newOrderId as string })
  return { status: "imported", wmsOrderId: newOrderId as string }
}
