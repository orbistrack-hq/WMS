import Link from "next/link"
import { AlertTriangle } from "lucide-react"

import { createClient } from "@/lib/supabase/server"

// Row shape from the central packaging_stock_report view (migration 0047):
// one row per packaging type, with precomputed low/negative flags.
type StockRow = {
  packaging_type_id: string
  packaging_name: string
  on_hand: number
  reorder_point: number | null
  is_active: boolean
  is_low: boolean
  is_negative: boolean
}

/**
 * Portal-wide low-stock alert. Renders a red bar at the top of every app page
 * whenever an active packaging type is at/below its alert quantity (reorder
 * point) or has gone negative. Returns null — nothing rendered — when all
 * packaging is healthy, so the banner only appears when it matters.
 *
 * The alert quantity per type is set by a manager under Settings → Packaging
 * (or Intake → Packaging). Reads of packaging_stock_report are open to any
 * signed-in user, so this works for every role.
 */
export async function PackagingLowStockBanner() {
  const supabase = await createClient()

  // Packaging is an internal-ops resource (receive/adjust is admin/operator/
  // manager only), so only show the alert to the ops team — a client/brand
  // login can't act on it. is_operator() covers admin, operator, and manager.
  const { data: isOps } = await supabase.rpc("is_operator")
  if (isOps !== true) return null

  const { data, error } = await supabase
    .from("packaging_stock_report")
    .select(
      "packaging_type_id, packaging_name, on_hand, reorder_point, is_active, is_low, is_negative",
    )
    .eq("is_active", true)
    .order("on_hand", { ascending: true })

  // Never block the portal on a banner failure — just render nothing.
  if (error || !data) return null

  const flagged = (data as StockRow[]).filter(
    (r) => r.is_low || r.is_negative,
  )
  if (flagged.length === 0) return null

  return (
    <div
      role="alert"
      className="no-print border-b border-destructive/30 bg-destructive/10 px-4 py-2.5 text-sm text-destructive md:px-6"
    >
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-2 gap-y-1">
        <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
        <span className="font-semibold">
          Low packaging stock ({flagged.length})
        </span>
        <span className="text-destructive/90">
          {flagged
            .map((r) =>
              r.is_negative
                ? `${r.packaging_name}: ${r.on_hand} (below zero)`
                : `${r.packaging_name}: ${r.on_hand} left${
                    r.reorder_point !== null
                      ? ` (alert at ${r.reorder_point})`
                      : ""
                  }`,
            )
            .join(" · ")}
        </span>
        <Link
          href="/inventory/packaging"
          className="ml-auto font-medium underline underline-offset-2 hover:no-underline"
        >
          Receive stock
        </Link>
      </div>
    </div>
  )
}
