import { createClient } from "@/lib/supabase/server"
import { childDisplayName } from "@/lib/catalog/weight"

export type NotificationItem = {
  label: string
  sub?: string
}

export type NotificationGroup = {
  key: "packaging_low" | "sku_low"
  title: string
  count: number
  href: string
  linkLabel: string
  items: NotificationItem[]
}

export type Notifications = {
  total: number
  groups: NotificationGroup[]
}

/**
 * Gathers the portal-wide ops alerts (low packaging stock + low child-SKU stock)
 * into one serializable structure for the header notifications drawer. Ops-only
 * (is_operator = admin/operator/manager) — a client/brand login gets nothing,
 * mirroring the old banners. Resilient: any query failure (incl. a not-yet-
 * migrated column) just omits that group instead of throwing.
 */
export async function getNotifications(): Promise<Notifications> {
  const supabase = await createClient()

  const { data: isOps } = await supabase.rpc("is_operator")
  if (isOps !== true) return { total: 0, groups: [] }

  const groups: NotificationGroup[] = []

  // ---- Low packaging stock -------------------------------------------------
  const { data: pkg, error: pkgErr } = await supabase
    .from("packaging_stock_report")
    .select(
      "packaging_type_id, packaging_name, on_hand, reorder_point, is_active, is_low, is_negative",
    )
    .eq("is_active", true)
    .order("on_hand", { ascending: true })

  if (!pkgErr && pkg) {
    const flagged = (
      pkg as Array<{
        packaging_name: string
        on_hand: number
        reorder_point: number | null
        is_low: boolean
        is_negative: boolean
      }>
    ).filter((r) => r.is_low || r.is_negative)
    if (flagged.length > 0) {
      groups.push({
        key: "packaging_low",
        title: "Low packaging stock",
        count: flagged.length,
        href: "/inventory/packaging",
        linkLabel: "Receive stock",
        items: flagged.slice(0, 8).map((r) => ({
          label: r.packaging_name,
          sub: r.is_negative
            ? `${r.on_hand} (below zero)`
            : `${r.on_hand} left${r.reorder_point !== null ? ` · alert at ${r.reorder_point}` : ""}`,
        })),
      })
    }
  }

  // ---- Low child-SKU stock -------------------------------------------------
  const { data: low, error: lowErr } = await supabase
    .from("inventory_report")
    .select(
      "child_sku_id, product_name, variant_label, grams_per_unit, site_name, on_hand, effective_low_stock_threshold, is_low",
    )
    .eq("is_low", true)
    .order("on_hand", { ascending: true })
    .limit(500)

  if (!lowErr && low) {
    const rows = low as Array<{
      product_name: string | null
      variant_label: string | null
      grams_per_unit: number | string | null
      site_name: string | null
      on_hand: number
      effective_low_stock_threshold: number
    }>
    if (rows.length > 0) {
      groups.push({
        key: "sku_low",
        title: "Low stock SKUs",
        count: rows.length,
        href: "/inventory?lowStock=1",
        linkLabel: "Review low stock",
        items: rows.slice(0, 8).map((r) => ({
          label: childDisplayName(
            r.product_name,
            r.variant_label,
            r.grams_per_unit,
          ),
          sub: `${r.on_hand} left${r.site_name ? ` · ${r.site_name}` : ""} · alert at ${r.effective_low_stock_threshold}`,
        })),
      })
    }
  }

  return { total: groups.reduce((a, g) => a + g.count, 0), groups }
}
