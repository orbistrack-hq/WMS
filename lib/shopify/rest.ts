import type { ShopifyInventoryItem } from "./types"

// ---------------------------------------------------------------------------
// Minimal Shopify Admin REST helpers shared by the catalog paths.
//
// Used by BOTH the manual product sync (integrations/shopify/actions.ts) and
// the webhook cost seed (process-event.ts) so unit cost is fetched the same way
// whichever path runs. Cost is NOT on the product/variant payload — it lives on
// the InventoryItem — so it always takes a separate Admin API call.
// ---------------------------------------------------------------------------

export const SHOPIFY_API_VERSION = "2024-10"

/**
 * Pull unit costs for a set of Shopify InventoryItems (cost lives there, not on
 * the variant). Batched ≤100 ids per call. A non-OK response (typically a token
 * missing the read_inventory scope) is non-fatal: we return what we have plus a
 * flag so the caller can sync price/stock and just skip cost seeding.
 */
export async function fetchVariantCosts(
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
