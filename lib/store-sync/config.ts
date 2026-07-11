/**
 * Store-sync behavioral flags.
 *
 * AUTO-FULFILL. When a store (Shopify / WooCommerce) reports an order completed
 * — e.g. ShipStation ships it and flips the store order to completed — should
 * WMS immediately run fulfill_order (consume reserved stock and jump the order
 * straight to 'fulfilled')?
 *
 * Default OFF. Auto-fulfill bypasses the WMS pick/pack screen, so packaging cost
 * and packaging stock are NEVER recorded for those orders, and a backordered
 * order silently fails to fulfil (the error is only logged). While off, a
 * store-completed order keeps its store number and stays in the normal pick/pack
 * flow so the team packs it and packaging/costs are captured. Cancellations
 * still sync regardless of this flag (releasing a reservation is always safe).
 *
 * Orders that were auto-fulfilled while this was ON surface in the
 * `orders_missing_packaging` report so their packaging can be recorded after
 * the fact.
 *
 * Flip on by setting STORE_SYNC_AUTOFULFILL=on once packaging capture on the
 * auto-fulfill path is solved.
 */
export function storeAutoFulfillEnabled(): boolean {
  return (process.env.STORE_SYNC_AUTOFULFILL ?? "").trim().toLowerCase() === "on"
}
