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
    barcode: string | null
    /** Per-unit weight; drives weight-based packaging (FB-3). May be absent. */
    grams_per_unit?: number | string | null
    product: { name: string | null } | null
  } | null
}

/** Coerce a Supabase numeric (number | string | null) to a finite number or null. */
function toGrams(v: number | string | null | undefined): number | null {
  if (v == null) return null
  const n = typeof v === "string" ? Number(v) : v
  return Number.isFinite(n) ? n : null
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
  barcode: string | null
  name: string
  qty: number
  /** Per-unit weight in grams, or null when the SKU has no weight set. */
  gramsPerUnit: number | null
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
          barcode: li.child_sku?.barcode ?? null,
          name: li.child_sku?.product?.name ?? "—",
          qty: li.quantity,
          gramsPerUnit: toGrams(li.child_sku?.grams_per_unit),
        })
      }
    }
  }

  const lines = [...byKey.values()].sort(comparePickRoute)
  const totalUnits = lines.reduce((n, l) => n + l.qty, 0)
  return { lines, orderNumbers, totalUnits }
}

// ---------------------------------------------------------------------------
// Wave (batch) picking — v1, ephemeral
// ---------------------------------------------------------------------------
// Consolidates the demand of MANY groups into one combined, bin-sorted pick so
// a picker walks the floor once for several orders. On top of the normal
// aggregation it keeps a per-group / per-order breakdown so the picked stock
// can be sorted back out to each order at a put-wall.
//
// v1 is deliberately schema-free: a wave is just a set of group ids carried in
// the URL, derived on the fly. Persisted waves + cross-group progress tracking
// (pick_progress.wave_id) are a v2 concern; nothing here writes to the database.

/** An active packaging type available to record usage against (box/label/jar/…). */
export type PackagingTypeOption = {
  id: string
  name: string
  kind: string
  unit_cost: number
}

/** One fulfillment group entering a wave, with a human label for the put-wall. */
export type WaveGroupInput = {
  id: string
  /** Customer name (or any short label) shown in the put-wall breakdown. */
  label: string
  orders: PickOrderRow[]
}

/** How many units of a SKU go to one order within the wave (put-wall row). */
export type WaveAllocation = {
  groupId: string
  groupLabel: string
  orderNumber: string
  qty: number
}

/** A consolidated wave pick row: the total to gather, plus where it goes. */
export type WavePickLine = PickLine & {
  /** Per-group/per-order split of `qty`, for sorting stock after the pick. */
  allocations: WaveAllocation[]
}

export type AggregatedWave = {
  /** Consolidated pick rows across every group, in walking-route order. */
  lines: WavePickLine[]
  /** Number of groups in the wave. */
  groupCount: number
  /** Every contributing order number across the wave (active orders only). */
  orderNumbers: string[]
  /** Total units to gather across the whole wave. */
  totalUnits: number
}

/**
 * Aggregate active demand across several groups into one combined pick.
 *
 * Same grouping key and route sort as {@link aggregatePickLines} (so a wave row
 * and a single-group row for the same SKU collapse identically), but each line
 * also carries an `allocations` list — one entry per (group, order) that needs
 * the SKU — for the put-wall sort stage.
 */
export function aggregateWave(groups: WaveGroupInput[]): AggregatedWave {
  const byKey = new Map<string, WavePickLine>()
  const orderNumbers: string[] = []

  for (const g of groups) {
    for (const o of g.orders) {
      if (!ACTIVE_PICK_STATUSES.has(o.status)) continue
      orderNumbers.push(o.order_number)
      for (const li of o.order_line_items) {
        if (li.quantity <= 0) continue
        const key = li.child_sku?.id ?? `sku:${li.child_sku?.sku ?? ""}`
        const alloc: WaveAllocation = {
          groupId: g.id,
          groupLabel: g.label,
          orderNumber: o.order_number,
          qty: li.quantity,
        }
        const existing = byKey.get(key)
        if (existing) {
          existing.qty += li.quantity
          // Merge into the same (group, order) bucket if it recurs, so the
          // put-wall shows one tidy number per order rather than duplicates.
          const sameDest = existing.allocations.find(
            (a) => a.groupId === alloc.groupId && a.orderNumber === alloc.orderNumber,
          )
          if (sameDest) sameDest.qty += li.quantity
          else existing.allocations.push(alloc)
        } else {
          byKey.set(key, {
            childSkuId: li.child_sku?.id ?? null,
            sku: li.child_sku?.sku ?? null,
            bin: li.child_sku?.bin_location ?? null,
            barcode: li.child_sku?.barcode ?? null,
            name: li.child_sku?.product?.name ?? "—",
            qty: li.quantity,
            gramsPerUnit: toGrams(li.child_sku?.grams_per_unit),
            allocations: [alloc],
          })
        }
      }
    }
  }

  const lines = [...byKey.values()].sort(comparePickRoute)
  // Stable, readable allocation order: by group label, then order number.
  for (const l of lines) {
    l.allocations.sort(
      (a, b) =>
        a.groupLabel.localeCompare(b.groupLabel) ||
        a.orderNumber.localeCompare(b.orderNumber),
    )
  }
  const totalUnits = lines.reduce((n, l) => n + l.qty, 0)
  return { lines, groupCount: groups.length, orderNumbers, totalUnits }
}

/**
 * Resolve a scanned/typed code to one of `items`: barcode first, then SKU code,
 * trimmed and case-insensitive. Returns null when nothing matches. Shared by
 * scan-to-pick (the runner) and scan-to-pack so both resolve codes identically.
 */
export function matchByCode<
  T extends { sku: string | null; barcode: string | null },
>(items: T[], code: string): T | null {
  const c = code.trim().toLowerCase()
  if (!c) return null
  return (
    items.find((i) => i.barcode && i.barcode.toLowerCase() === c) ??
    items.find((i) => i.sku && i.sku.toLowerCase() === c) ??
    null
  )
}
