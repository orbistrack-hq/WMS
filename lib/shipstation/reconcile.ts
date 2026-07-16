import type { SupabaseClient } from "@supabase/supabase-js"

// ---------------------------------------------------------------------------
// OT ⇄ ShipStation alignment. Pulls several ShipStation order statuses and the
// OT orders they map to, then computes a set of discrepancy buckets. Every
// bucket is a list of ReconcileRow so the screen renders them uniformly and new
// checks slot in without a rewrite.
// ---------------------------------------------------------------------------

const READY_STATUSES = ["created", "picking", "packed"]
/**
 * OT-not-in-SS orders newer than this are "probably still syncing" (benign).
 * ShipStation pulls from the stores roughly every 2-3 hours, so we wait ~3h
 * before calling an order genuinely missing.
 */
export const SYNC_GRACE_MINUTES = 180
/** OT ready orders older than this with no movement are flagged as aging. */
export const AGING_DAYS = 3
/** How far back to pull ShipStation "shipped" orders for the cross-check. */
const SHIPPED_LOOKBACK_DAYS = 7
/** OT lookback window (keeps the cross-reference bounded). */
const OT_LOOKBACK_DAYS = 45

export type ReconcileRow = {
  orderNumber: string
  channel: string | null
  ageMinutes: number | null
  /** Extra context for drift/holding rows, e.g. "OT 5 vs SS 3" or "SS on_hold". */
  note?: string
}

export type ReconcileResult = {
  otReady: number
  ssAwaiting: number
  matched: number
  graceMinutes: number
  agingDays: number
  ranAt: string
  // Presence
  syncing: ReconcileRow[]
  missing: ReconcileRow[]
  extra: ReconcileRow[]
  // Tier 1 — can cause a wrong shipment
  shippedNotFulfilled: ReconcileRow[]
  cancelledButAwaiting: ReconcileRow[]
  // Tier 2 — data drift on matched orders
  qtyMismatch: ReconcileRow[]
  addressMismatch: ReconcileRow[]
  // Tier 3 — hygiene
  ssHoldingButOtReady: ReconcileRow[]
  aging: ReconcileRow[]
  duplicateImports: ReconcileRow[]
}

type SsOrder = {
  orderNumber?: string | null
  orderStatus?: string | null
  advancedOptions?: { storeId?: number }
  items?: { quantity?: number | null; name?: string | null }[]
  shipTo?: { name?: string | null; postalCode?: string | null }
}

type OtOrder = {
  order_number: string
  channel: string | null
  status: string
  on_hold: boolean
  entered_at: string | null
  ship_to_name: string | null
  ship_to_postal: string | null
  order_line_items: {
    quantity: number | null
    child_sku: { track_inventory: boolean | null } | null
  }[]
}

// Non-inventory service lines (Route "Shipping Protection") must not count toward
// the physical-unit comparison. OT flags them with track_inventory=false (name
// pattern `shipping protection%`, migration 0068); ShipStation has no such flag,
// so match its item name to the same keyword.
const NONINVENTORY_ITEM = /shipping protection/i

// --- order-number matching -------------------------------------------------
function keysFor(raw: string | null | undefined): { alnum: string; digits: string } {
  const s = String(raw ?? "")
    .replace(/^(WOO|SHOP)-/i, "")
    .toLowerCase()
  return { alnum: s.replace(/[^a-z0-9]/g, ""), digits: s.replace(/[^0-9]/g, "") }
}

/** Map both normalized keys → item, so lookups tolerate "#1678" vs "TSU#1678". */
function mapByKeys<T>(items: T[], getRaw: (t: T) => string | null | undefined) {
  const m = new Map<string, T>()
  for (const it of items) {
    const { alnum, digits } = keysFor(getRaw(it))
    if (alnum) m.set("a:" + alnum, it)
    if (digits) m.set("d:" + digits, it)
  }
  return m
}

function lookup<T>(m: Map<string, T>, raw: string | null | undefined): T | undefined {
  const { alnum, digits } = keysFor(raw)
  return (alnum && m.get("a:" + alnum)) || (digits && m.get("d:" + digits)) || undefined
}

const norm = (s: string | null | undefined) =>
  String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "")

// --- ShipStation fetch -----------------------------------------------------
async function fetchSs(
  apiKey: string,
  apiSecret: string,
  query: string,
): Promise<SsOrder[]> {
  const auth = "Basic " + Buffer.from(`${apiKey}:${apiSecret}`).toString("base64")
  const out: SsOrder[] = []
  for (let page = 1; page <= 200; page++) {
    const res = await fetch(
      `https://ssapi.shipstation.com/orders?${query}&pageSize=500&page=${page}`,
      { headers: { Authorization: auth, "Content-Type": "application/json" } },
    )
    if (res.status === 429) {
      const wait = Number(res.headers.get("X-Rate-Limit-Reset") ?? 60) * 1000
      await new Promise((r) => setTimeout(r, wait + 500))
      page--
      continue
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "")
      throw new Error(`ShipStation ${res.status}: ${body.slice(0, 160)}`)
    }
    const json = (await res.json()) as { orders?: SsOrder[]; pages?: number }
    out.push(...(json.orders ?? []))
    if (page >= (json.pages ?? 1)) break
  }
  return out
}

function ssStoreLabel(o: SsOrder): string | null {
  return o.advancedOptions?.storeId ? `SS store ${o.advancedOptions.storeId}` : null
}
// Physical units only — exclude non-inventory / service lines on both sides.
function ssUnits(o: SsOrder): number {
  return (o.items ?? []).reduce(
    (n, i) => n + (NONINVENTORY_ITEM.test(i.name ?? "") ? 0 : (i.quantity ?? 0)),
    0,
  )
}
function otUnits(o: OtOrder): number {
  return o.order_line_items.reduce(
    (n, li) => n + (li.child_sku?.track_inventory === false ? 0 : (li.quantity ?? 0)),
    0,
  )
}

// Postal match tolerant of ZIP+4: "34761" and "34761-4029" are the same place.
// True when equal, or the shorter (≥4 chars) is a prefix of the longer.
function postalMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = norm(a)
  const y = norm(b)
  if (!x || !y) return true // nothing to compare — don't flag
  if (x === y) return true
  const [short, long] = x.length <= y.length ? [x, y] : [y, x]
  return short.length >= 4 && long.startsWith(short)
}

/** Run the full OT ⇄ ShipStation reconciliation. `db` must be service-role. */
export async function reconcileShipStation(
  db: SupabaseClient,
  apiKey: string,
  apiSecret: string,
): Promise<ReconcileResult> {
  const now = Date.now()
  const shippedSince = new Date(now - SHIPPED_LOOKBACK_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10)

  // OT orders (bounded window) with the fields every check needs.
  const otSince = new Date(now - OT_LOOKBACK_DAYS * 86_400_000).toISOString()
  const ot: OtOrder[] = []
  const pageSize = 1000
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await db
      .from("orders")
      .select(
        "order_number, channel, status, on_hold, entered_at, ship_to_name, ship_to_postal, order_line_items(quantity, child_sku:child_skus(track_inventory))",
      )
      .in("channel", ["shopify", "woocommerce"])
      .gte("entered_at", otSince)
      .range(from, from + pageSize - 1)
    if (error) throw new Error(`load OT orders: ${error.message}`)
    ot.push(...((data ?? []) as unknown as OtOrder[]))
    if (!data || data.length < pageSize) break
  }

  const [ssAwaiting, ssShipped, ssHold, ssAwaitingPay] = await Promise.all([
    fetchSs(apiKey, apiSecret, "orderStatus=awaiting_shipment"),
    fetchSs(apiKey, apiSecret, `orderStatus=shipped&modifyDateStart=${shippedSince}`),
    fetchSs(apiKey, apiSecret, "orderStatus=on_hold"),
    fetchSs(apiKey, apiSecret, "orderStatus=awaiting_payment"),
  ])

  const otAll = mapByKeys(ot, (o) => o.order_number)
  const otReady = ot.filter((o) => READY_STATUSES.includes(o.status) && !o.on_hold)
  const ssAwaitingByKey = mapByKeys(ssAwaiting, (o) => o.orderNumber)
  const otReadyByKey = mapByKeys(otReady, (o) => o.order_number)

  const rowOt = (o: OtOrder, note?: string): ReconcileRow => ({
    orderNumber: o.order_number,
    channel: o.channel,
    ageMinutes: o.entered_at
      ? Math.round((now - new Date(o.entered_at).getTime()) / 60000)
      : null,
    note,
  })
  const rowSs = (o: SsOrder, note?: string): ReconcileRow => ({
    orderNumber: o.orderNumber ?? "?",
    channel: ssStoreLabel(o),
    ageMinutes: null,
    note,
  })

  // Presence: OT ready not in SS awaiting, split by age.
  const syncing: ReconcileRow[] = []
  const missing: ReconcileRow[] = []
  for (const o of otReady) {
    if (lookup(ssAwaitingByKey, o.order_number)) continue
    const r = rowOt(o)
    if (r.ageMinutes != null && r.ageMinutes <= SYNC_GRACE_MINUTES) syncing.push(r)
    else missing.push(r)
  }
  const extra: ReconcileRow[] = ssAwaiting
    .filter((o) => o.orderNumber && !lookup(otReadyByKey, o.orderNumber))
    .map((o) => rowSs(o))

  // Tier 1: SS shipped but OT still to-pack.
  const shippedNotFulfilled: ReconcileRow[] = []
  for (const s of ssShipped) {
    const o = lookup(otAll, s.orderNumber)
    if (o && READY_STATUSES.includes(o.status))
      shippedNotFulfilled.push(rowOt(o, "shipped in ShipStation"))
  }

  // Tier 1: OT cancelled but SS still awaiting.
  const cancelledButAwaiting: ReconcileRow[] = ot
    .filter((o) => o.status === "cancelled" && lookup(ssAwaitingByKey, o.order_number))
    .map((o) => rowOt(o, "cancelled in OT, still Awaiting in ShipStation"))

  // Tier 2: qty + address drift on matched (OT ready ∩ SS awaiting).
  const qtyMismatch: ReconcileRow[] = []
  const addressMismatch: ReconcileRow[] = []
  for (const o of otReady) {
    const s = lookup(ssAwaitingByKey, o.order_number)
    if (!s) continue
    const otQ = otUnits(o)
    const ssQ = ssUnits(s)
    if (ssQ > 0 && otQ !== ssQ)
      qtyMismatch.push(rowOt(o, `OT ${otQ} vs ShipStation ${ssQ} units`))
    if (!postalMatch(o.ship_to_postal, s.shipTo?.postalCode))
      addressMismatch.push(rowOt(o, `postal ${o.ship_to_postal} vs ${s.shipTo?.postalCode}`))
  }

  // Tier 3: SS holding (on_hold / awaiting_payment) but OT ready.
  const ssHoldingButOtReady: ReconcileRow[] = []
  for (const s of [...ssHold, ...ssAwaitingPay]) {
    const o = lookup(otReadyByKey, s.orderNumber)
    if (o) ssHoldingButOtReady.push(rowOt(o, `ShipStation ${s.orderStatus}`))
  }

  // Tier 3: aging — matched (in both systems) but ready for > AGING_DAYS. Orders
  // that are missing/syncing are already surfaced above, so exclude them here.
  const agingCutoff = AGING_DAYS * 24 * 60
  const aging: ReconcileRow[] = otReady
    .filter((o) => lookup(ssAwaitingByKey, o.order_number))
    .map((o) => rowOt(o))
    .filter((r) => r.ageMinutes != null && r.ageMinutes > agingCutoff)
    .sort((a, b) => (b.ageMinutes ?? 0) - (a.ageMinutes ?? 0))

  // Tier 3: duplicate imports — one store order mapped to >1 OT order.
  const duplicateImports: ReconcileRow[] = []
  const { data: imps } = await db
    .from("store_order_imports")
    .select("channel, source, external_order_id, wms_order_id")
    .not("wms_order_id", "is", null)
  const seen = new Map<string, Set<string>>()
  for (const r of imps ?? []) {
    const k = `${r.channel}|${r.source}|${r.external_order_id}`
    if (!seen.has(k)) seen.set(k, new Set())
    seen.get(k)!.add(r.wms_order_id as string)
  }
  for (const [k, ids] of seen) {
    if (ids.size > 1)
      duplicateImports.push({
        orderNumber: k.split("|").pop() ?? k,
        channel: k.split("|")[0],
        ageMinutes: null,
        note: `${ids.size} OT orders share this store order`,
      })
  }

  const byAge = (a: ReconcileRow, b: ReconcileRow) => (b.ageMinutes ?? 0) - (a.ageMinutes ?? 0)
  syncing.sort(byAge)
  missing.sort(byAge)

  return {
    otReady: otReady.length,
    ssAwaiting: ssAwaiting.length,
    matched: otReady.length - syncing.length - missing.length,
    graceMinutes: SYNC_GRACE_MINUTES,
    agingDays: AGING_DAYS,
    ranAt: new Date().toISOString(),
    syncing,
    missing,
    extra,
    shippedNotFulfilled,
    cancelledButAwaiting,
    qtyMismatch,
    addressMismatch,
    ssHoldingButOtReady,
    aging,
    duplicateImports,
  }
}
