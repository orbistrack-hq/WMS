// ---------------------------------------------------------------------------
// Shared pick-list aggregation
// ---------------------------------------------------------------------------
// Collapses order line items into one row per child SKU and sorts them into a
// walking route (bin first). Used by the printable pick list and the
// interactive pick runner, and built to take the orders of one OR many
// fulfillment groups so wave picking can reuse it unchanged.
//
// Keep new pick UIs on this helper instead of re-deriving the reducer — the
// route sort and the child_sku_id key (which pick_progress is keyed on) must
// stay identical across the print view, the runner, and waves.

/** Statuses still "on the floor" — what a picker needs to gather. */
export const ACTIVE_PICK_STATUSES = new Set(["created", "picking", "packed"])

/** One order line item, shaped to match the pick-list Supabase select. */
export type PickLineItemRow = {
  quantity: number
  child_sku: {
    id: string
    sku: string | null
    bin_location: string | null
    product: { name: string | null } | null
  } | null
}

/** One order within a group, shaped to match the pick-list Supabase select. */
export type PickOrderRow = {
  order_number: string
  status: string
  order_line_items: PickLineItemRow[]
}

/** One aggregated pick row: a child SKU and the total quantity to gather. */
export type PickLine = {
  /**
   * child_skus.id — the stable key pick_progress is keyed on. Null only for the
   * rare line whose child SKU was deleted; such rows fall back to a sku-based
   * grouping key and can't be progress-tracked.
   */
  childSkuId: string | null
  sku: string | null
  bin: string | null
  name: string
  qty: number
}

export type AggregatedPick = {
  /** Pick rows, already in walking-route order. */
  lines: PickLine[]
  /** Order numbers contributing to this pick (active orders only). */
  orderNumbers: string[]
  /** Total units across all lines. */
  totalUnits: number
}

/**
 * Walking-route order: bin first (blanks last) so the picker makes one pass,
 * then SKU (blanks last), then product name as a stable tiebreak.
 */
export function comparePickRoute(a: PickLine, b: PickLine): number {
  if (a.bin && b.bin) {
    const c = a.bin.localeCompare(b.bin)
    if (c !== 0) return c
  } else if (a.bin) return -1
  else if (b.bin) return 1
  if (a.sku && b.sku) {
    const c = a.sku.localeCompare(b.sku)
    if (c !== 0) return c
  } else if (a.sku) return -1
  else if (b.sku) return 1
  return a.name.localeCompare(b.name)
}

/**
 * Aggregate active orders' line items by child SKU. Pass one group's orders for
 * a normal pick list, or many groups' orders concatenated for a wave.
 */
export function aggregatePickLines(orders: PickOrderRow[]): AggregatedPick {
  const byKey = new Map<string, PickLine>()
  const orderNumbers: string[] = []

  for (const o of orders) {
    if (!ACTIVE_PICK_STATUSES.has(o.status)) continue
    orderNumbers.push(o.order_number)
    for (const li of o.order_line_items) {
      // Prefer the child SKU id; fall back to a sku-based key for orphaned lines
      // so they still aggregate sensibly even though they can't be tracked.
      const key = li.child_sku?.id ?? `sku:${li.child_sku?.sku ?? ""}`
      const existing = byKey.get(key)
      if (existing) {
        existing.qty += li.quantity
      } else {
        byKey.set(key, {
          childSkuId: li.child_sku?.id ?? null,
          sku: li.child_sku?.sku ?? null,
          bin: li.child_sku?.bin_location ?? null,
          name: li.child_sku?.product?.name ?? "—",
          qty: li.quantity,
        })
      }
    }
  }

  const lines = [...byKey.values()].sort(comparePickRoute)
  const totalUnits = lines.reduce((n, l) => n + l.qty, 0)
  return { lines, orderNumbers, totalUnits }
}
