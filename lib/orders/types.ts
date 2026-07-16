import type { ComponentProps } from "react"

import type { Badge } from "@/components/ui/badge"

// ---------------------------------------------------------------------------
// Order status flow (mirrors the DB check constraint + lifecycle functions).
// 'fulfilled' and 'cancelled' are terminal and only reachable through the
// fulfill_order() / cancel_order() RPCs — never a bare status update.
// ---------------------------------------------------------------------------
export const ORDER_STATUSES = [
  "pending_payment",
  "created",
  "picking",
  "packed",
  "fulfilled",
  "cancelled",
  "returned",
] as const
export type OrderStatus = (typeof ORDER_STATUSES)[number]

/** Label-only moves allowed via set_order_status (no inventory/billing effects). */
export const LABEL_STATUSES = ["created", "picking", "packed"] as const
// 'returned' is terminal but re-openable (reopen_order → created); it is not a
// label-move target and is reached only via return_order() from 'fulfilled'.
export const TERMINAL_STATUSES = ["fulfilled", "cancelled", "returned"] as const

export const ORDER_TYPES = ["standard", "layaway"] as const
export type OrderType = (typeof ORDER_TYPES)[number]

export const ORDER_CHANNELS = ["manual", "shopify", "woocommerce"] as const
export type OrderChannel = (typeof ORDER_CHANNELS)[number]

type BadgeVariant = ComponentProps<typeof Badge>["variant"]

export const STATUS_BADGE: Record<
  OrderStatus,
  { label: string; variant: BadgeVariant }
> = {
  pending_payment: { label: "Pending payment", variant: "warning" },
  created: { label: "Created", variant: "secondary" },
  picking: { label: "Picking", variant: "info" },
  packed: { label: "Packed", variant: "warning" },
  fulfilled: { label: "Fulfilled", variant: "success" },
  cancelled: { label: "Cancelled", variant: "muted" },
  returned: { label: "Returned", variant: "warning" },
}

/**
 * Badge for an order. Held orders all share the pending_payment status, so the
 * label is refined by hold_reason: a Woo on-hold order reads "On hold" while a
 * pending-payment order reads "Pending payment". Display-only — they behave
 * identically underneath. Every other status uses STATUS_BADGE directly.
 */
export function orderBadge(
  status: OrderStatus,
  holdReason?: string | null,
): { label: string; variant: BadgeVariant } {
  if (status === "pending_payment" && holdReason === "on_hold") {
    return { label: "On hold", variant: "warning" }
  }
  return STATUS_BADGE[status]
}

export const CHANNEL_LABEL: Record<OrderChannel, string> = {
  manual: "Manual",
  shopify: "Shopify",
  woocommerce: "WooCommerce",
}

export const ORDER_TYPE_LABEL: Record<OrderType, string> = {
  standard: "Standard",
  layaway: "Layaway",
}

/** Can this order still take label-only status moves? A held (pending_payment)
 *  order cannot — it must be activated (payment cleared) first, which reserves
 *  stock, so set_order_status refuses it. */
export function isActive(status: OrderStatus): boolean {
  return (
    status !== "pending_payment" &&
    status !== "fulfilled" &&
    status !== "cancelled" &&
    status !== "returned"
  )
}

// ---------------------------------------------------------------------------
// Order totals — one canonical computation used by both the list and detail
// views. Deliberately LINE-LEVEL only — sum(qty*price - discount + tax) — to
// match the DB's order_payment_summary.total_due, which is the system's source
// of truth for what an order is worth / what a layaway owes. (orders also
// carries order-level discount_total/tax_total; those overlap with the
// per-line figures and are flagged in migration 0006 for reconciliation, so we
// do NOT add them here and risk double-counting.)
// ---------------------------------------------------------------------------
export type LineLike = {
  quantity: number
  unit_price: number | string
  discount?: number | string | null
  tax?: number | string | null
}

const num = (v: number | string | null | undefined): number => {
  const n = typeof v === "string" ? Number(v) : (v ?? 0)
  return Number.isFinite(n) ? n : 0
}

export function computeOrderTotals(lines: LineLike[]) {
  let itemsSubtotal = 0
  let itemCount = 0
  let total = 0
  for (const l of lines) {
    const qty = num(l.quantity)
    const gross = qty * num(l.unit_price)
    itemsSubtotal += gross
    itemCount += qty
    total += gross - num(l.discount) + num(l.tax)
  }
  return { itemsSubtotal, itemCount, total }
}
