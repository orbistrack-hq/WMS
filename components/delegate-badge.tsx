import Link from "next/link"
import { Link2 } from "lucide-react"

import { Badge } from "@/components/ui/badge"

/**
 * A BOGO "free" child SKU holds no stock of its own — its stock lives on the
 * paid counterpart's pool (migration 0077, `delegates_to_child_sku_id`). The
 * numbers you see on a delegate are the PAID SKU's numbers.
 *
 * Without this the two rows read as separate piles and the same jars get
 * counted twice by eye. It is also why receive/adjust are blocked on a delegate:
 * `receive_stock` and `adjust_stock` raise, and `set_on_hand_to` no-ops. Saying
 * so up front beats letting someone discover it through an error message.
 */
export type DelegateTarget = {
  /** child_sku_id of the paid counterpart whose pool this SKU draws from. */
  id: string
  /** Paid SKU code, for display. Null when the paid row has no SKU set. */
  sku: string | null
}

/** Inline chip. Use anywhere a delegate SKU is named — lists and headers. */
export function DelegateBadge({
  target,
  href = true,
  className,
}: {
  target: DelegateTarget
  /** Link through to the paid SKU. Off inside an existing link. */
  href?: boolean
  className?: string
}) {
  const label = target.sku ?? "paid SKU"
  const chip = (
    <Badge variant="info" className={className} title={`Stock is tracked on ${label}`}>
      <Link2 aria-hidden />
      Shares stock with {label}
    </Badge>
  )
  if (!href) return chip
  return (
    <Link
      href={`/inventory/${target.id}`}
      className="inline-flex underline-offset-4 hover:underline"
    >
      {chip}
    </Link>
  )
}

/**
 * Block-level explanation. Replaces the receive/adjust and transfer controls on
 * a delegate's detail page, so the action the user wants is one click away
 * instead of one failed request away.
 */
export function DelegateNotice({ target }: { target: DelegateTarget }) {
  const label = target.sku ?? "the paid SKU"
  return (
    <div className="flex flex-col gap-2 text-sm">
      <p className="text-muted-foreground">
        This is a BOGO SKU. It holds no stock of its own — every figure above is{" "}
        {label}&apos;s, and both rows describe the same physical jars.
      </p>
      <p className="text-muted-foreground">
        Receiving, adjusting and transferring all happen on {label}.
      </p>
      <Link
        href={`/inventory/${target.id}`}
        className="inline-flex w-fit items-center gap-1 font-medium underline-offset-4 hover:underline"
      >
        <Link2 className="size-4" aria-hidden />
        Go to {label}
      </Link>
    </div>
  )
}
