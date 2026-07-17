import type { WooVariation } from "./types"

// ---------------------------------------------------------------------------
// Minimal WooCommerce REST client helpers shared by the catalog paths.
//
// Used by BOTH the manual product sync (integrations/woocommerce/actions.ts)
// and the webhook self-heal (process-event.ts) so a variable product's
// variations are fetched the exact same way whichever path runs.
// ---------------------------------------------------------------------------

/** HTTP Basic auth header for a Woo REST consumer key/secret pair. */
export function wooAuthHeader(consumerKey: string, consumerSecret: string): string {
  const token = Buffer.from(`${consumerKey}:${consumerSecret}`).toString("base64")
  return `Basic ${token}`
}

/** REST v3 base URL for a connection's canonical store `source`. */
export function wooApiBase(source: string): string {
  return `${source}/wp-json/wc/v3`
}

/**
 * Fetch every variation object for a variable product, following pagination.
 * A variable product's webhook (and order/product list payloads) carry only
 * variation IDs, so the full objects — attributes, SKU, price, stock — must be
 * pulled from /products/{id}/variations before they can map to child SKUs.
 *
 * Throws when the first page fails (store unreachable / bad creds) so the
 * caller can fall back; a mid-pagination failure just stops with what we have.
 */
export async function fetchWooVariations(
  base: string,
  auth: { Authorization: string },
  productId: string | number,
): Promise<WooVariation[]> {
  const out: WooVariation[] = []
  for (let page = 1; page <= 20; page++) {
    const vr = await fetch(
      `${base}/products/${productId}/variations?per_page=100&page=${page}`,
      { headers: auth },
    )
    if (!vr.ok) {
      if (page === 1) {
        throw new Error(`WooCommerce variations fetch failed: ${vr.status}`)
      }
      break
    }
    const batch = (await vr.json()) as WooVariation[]
    if (!Array.isArray(batch) || batch.length === 0) break
    out.push(...batch)
    if (batch.length < 100) break
  }
  return out
}
