import Link from "next/link"
import { PackageMinus } from "lucide-react"

import { createClient } from "@/lib/supabase/server"

// Row shape from inventory_report (migration 0079): one row per child SKU with a
// precomputed low-stock flag (on_hand basis, effective threshold).
type LowRow = {
  child_sku_id: string
  product_name: string | null
  variant_label: string | null
  grams_per_unit: number | string | null
  site_name: string | null
  on_hand: number
  effective_low_stock_threshold: number
}

function childLabel(r: LowRow): string {
  const base = r.product_name ?? "Unnamed"
  const variant =
    r.variant_label ??
    (r.grams_per_unit != null ? `${r.grams_per_unit}g` : null)
  return variant ? `${base} (${variant})` : base
}

/**
 * Portal-wide low-stock alert for child SKUs. Renders an amber bar at the top of
 * every app page whenever an active, inventory-tracked child SKU is at/below its
 * effective low-stock threshold (per-child override or the app-wide default; a
 * threshold of 0 silences a SKU). Returns null when nothing is low.
 *
 * Ops-only (is_operator = admin/operator/manager), same as the packaging banner —
 * a client/brand login can't act on stock. Links to the inventory list filtered
 * to just the low-stock SKUs, where thresholds can be tuned in bulk.
 */
export async function LowStockBanner() {
  const supabase = await createClient()

  const { data: isOps } = await supabase.rpc("is_operator")
  if (isOps !== true) return null

  const { data, error } = await supabase
    .from("inventory_report")
    .select(
      "child_sku_id, product_name, variant_label, grams_per_unit, site_name, on_hand, effective_low_stock_threshold",
    )
    .eq("is_low", true)
    .order("on_hand", { ascending: true })
    .limit(500)

  // Never block the portal on a banner failure — just render nothing.
  if (error || !data || data.length === 0) return null

  const rows = data as LowRow[]
  // Show a few by name, summarise the rest — the list can be long.
  const preview = rows.slice(0, 4)
  const extra = rows.length - preview.length

  return (
    <div
      role="alert"
      className="no-print border-b border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-sm text-amber-700 md:px-6 dark:text-amber-400"
    >
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-2 gap-y-1">
        <PackageMinus className="size-4 shrink-0" aria-hidden="true" />
        <span className="font-semibold">Low stock ({rows.length})</span>
        <span className="opacity-90">
          {preview
            .map(
              (r) =>
                `${childLabel(r)}${r.site_name ? ` · ${r.site_name}` : ""}: ${r.on_hand} left (alert at ${r.effective_low_stock_threshold})`,
            )
            .join(" · ")}
          {extra > 0 ? ` · +${extra} more` : ""}
        </span>
        <Link
          href="/inventory?lowStock=1"
          className="ml-auto font-medium underline underline-offset-2 hover:no-underline"
        >
          Review low stock
        </Link>
      </div>
    </div>
  )
}
