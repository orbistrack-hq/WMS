// ---------------------------------------------------------------------------
// Inventory ledger — friendly labels for the append-only change log.
// Reasons mirror the inventory_ledger.reason CHECK constraint (migration 0001).
// ---------------------------------------------------------------------------

import type { ComponentProps } from "react"

import type { Badge } from "@/components/ui/badge"

export type LedgerReason =
  | "order_reserve"
  | "order_release"
  | "order_consume"
  | "layaway_remove"
  | "manual_adjustment"
  | "receipt"
  | "correction"
  | "transfer_out"
  | "transfer_in"

type BadgeVariant = ComponentProps<typeof Badge>["variant"]

export const REASON_LABEL: Record<LedgerReason, string> = {
  order_reserve: "Order reserved",
  order_release: "Order released",
  order_consume: "Order fulfilled",
  layaway_remove: "Layaway removed",
  manual_adjustment: "Manual adjustment",
  receipt: "Stock received",
  correction: "Correction",
  transfer_out: "Transferred out",
  transfer_in: "Transferred in",
}

export const REASON_BADGE: Record<LedgerReason, BadgeVariant> = {
  order_reserve: "info",
  order_release: "secondary",
  order_consume: "success",
  layaway_remove: "warning",
  manual_adjustment: "outline",
  receipt: "success",
  correction: "outline",
  transfer_out: "warning",
  transfer_in: "info",
}

export function reasonLabel(reason: string): string {
  return REASON_LABEL[reason as LedgerReason] ?? reason
}

export function reasonBadge(reason: string): BadgeVariant {
  return REASON_BADGE[reason as LedgerReason] ?? "muted"
}

/** Format a signed integer delta, e.g. 5 -> "+5", -3 -> "−3", 0 -> "—". */
export function formatDelta(n: number): string {
  if (!n) return "—"
  return n > 0 ? `+${n}` : `−${Math.abs(n)}`
}
