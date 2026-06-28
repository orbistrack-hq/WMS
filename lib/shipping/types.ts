import type { ComponentProps } from "react"

import type { Badge } from "@/components/ui/badge"

// ---------------------------------------------------------------------------
// Shipment status flow (mirrors the DB check constraint on shipments.status).
// Shipping is operational only — these statuses are independent of the order
// lifecycle. 'cancelled' is terminal; the others move freely.
// ---------------------------------------------------------------------------
export const SHIPMENT_STATUSES = [
  "pending",
  "shipped",
  "delivered",
  "cancelled",
] as const
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number]

type BadgeVariant = ComponentProps<typeof Badge>["variant"]

export const SHIPMENT_STATUS_BADGE: Record<
  ShipmentStatus,
  { label: string; variant: BadgeVariant }
> = {
  pending: { label: "Pending", variant: "secondary" },
  shipped: { label: "Shipped", variant: "info" },
  delivered: { label: "Delivered", variant: "success" },
  cancelled: { label: "Cancelled", variant: "muted" },
}

/** Forward-going next status, or null if there isn't one. */
export const NEXT_SHIPMENT_STATUS: Record<ShipmentStatus, ShipmentStatus | null> =
  {
    pending: "shipped",
    shipped: "delivered",
    delivered: null,
    cancelled: null,
  }

// Common carriers / service levels for the picker. Free text is still allowed
// in the DB, so these are convenience defaults, not an enum.
export const CARRIERS = ["USPS", "UPS", "FedEx", "DHL", "Other"] as const

// ---------------------------------------------------------------------------
// Row shapes the shipping panel works with.
// ---------------------------------------------------------------------------
export type PackageRow = {
  id: string
  tracking_number: string | null
  cost: number | null
  weight_grams: number | null
}

export type ShipmentRow = {
  id: string
  carrier: string | null
  service_level: string | null
  estimated_cost: number | null
  actual_cost: number | null
  status: ShipmentStatus
  packages: PackageRow[]
}

const num = (v: number | string | null | undefined): number => {
  const n = typeof v === "string" ? Number(v) : (v ?? 0)
  return Number.isFinite(n) ? n : 0
}

/**
 * Roll a group's shipments up into the figures the panel header shows.
 * Package costs sum independently of the shipment-level actual_cost — the two
 * are separate accounting lines (the shipping_cost_report keeps them apart too).
 */
export function summarizeShipping(shipments: ShipmentRow[]) {
  let estimated = 0
  let actual = 0
  let packageCount = 0
  let packageCost = 0
  let weightGrams = 0
  for (const s of shipments) {
    if (s.status === "cancelled") continue
    estimated += num(s.estimated_cost)
    actual += num(s.actual_cost)
    for (const p of s.packages) {
      packageCount += 1
      packageCost += num(p.cost)
      weightGrams += num(p.weight_grams)
    }
  }
  return { estimated, actual, packageCount, packageCost, weightGrams }
}

/** Grams → e.g. "1.20 kg" / "850 g". */
export function formatWeight(grams: number | null | undefined): string {
  const g = num(grams)
  if (g <= 0) return "—"
  return g >= 1000 ? `${(g / 1000).toFixed(2)} kg` : `${g} g`
}
