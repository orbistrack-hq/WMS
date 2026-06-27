import Link from "next/link"
import { notFound } from "next/navigation"
import { ArrowLeft } from "lucide-react"

import { createClient } from "@/lib/supabase/server"
import { formatDateTime } from "@/lib/format"
import { PrintButton } from "./print-button"

export const dynamic = "force-dynamic"

// Orders still on the floor — they're what a picker needs to gather. Cancelled
// and fulfilled orders are excluded.
const ACTIVE = new Set(["created", "picking", "packed"])

type PickGroup = {
  id: string
  customer: { name: string | null } | null
  site: { name: string | null } | null
  orders: {
    order_number: string
    status: string
    order_line_items: {
      quantity: number
      child_sku: {
        id: string
        sku: string | null
        bin_location: string | null
        product: { name: string | null } | null
      } | null
    }[]
  }[]
}

type PickLine = {
  sku: string | null
  bin: string | null
  name: string
  qty: number
}

export default async function PickListPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const supabase = await createClient()

  const { data } = await supabase
    .from("fulfillment_groups")
    .select(
      `id,
       customer:customers(name),
       site:sites(name),
       orders(order_number, status,
         order_line_items(quantity,
           child_sku:child_skus(id, sku, bin_location, product:products(name))))`,
    )
    .eq("id", id)
    .maybeSingle()

  if (!data) notFound()
  const group = data as unknown as PickGroup

  // Aggregate by child SKU across the group's active orders: pick once per SKU.
  const byKey = new Map<string, PickLine>()
  const orderNumbers: string[] = []
  for (const o of group.orders) {
    if (!ACTIVE.has(o.status)) continue
    orderNumbers.push(o.order_number)
    for (const li of o.order_line_items) {
      const key = li.child_sku?.id ?? `${li.child_sku?.sku ?? ""}`
      const existing = byKey.get(key)
      if (existing) {
        existing.qty += li.quantity
      } else {
        byKey.set(key, {
          sku: li.child_sku?.sku ?? null,
          bin: li.child_sku?.bin_location ?? null,
          name: li.child_sku?.product?.name ?? "—",
          qty: li.quantity,
        })
      }
    }
  }

  // Sort into a walking route: bin first (blanks last) so the picker makes one
  // efficient pass, then SKU (blanks last), then product name as a tiebreak.
  const lines = [...byKey.values()].sort((a, b) => {
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
  })
  const totalUnits = lines.reduce((n, l) => n + l.qty, 0)

  return (
    <>
      <div className="no-print mb-4 flex items-center justify-between">
        <Link
          href={`/packing/${group.id}`}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" /> Back to group
        </Link>
        <PrintButton />
      </div>

      <div className="print-root mx-auto max-w-3xl text-sm text-black">
        <div className="mb-4 flex items-start justify-between border-b pb-3">
          <div>
            <h1 className="text-xl font-bold">Pick list</h1>
            <p className="text-muted-foreground">
              {group.customer?.name ?? "Walk-in / no customer"}
              {group.site?.name ? ` · ${group.site.name}` : ""}
            </p>
            <p className="text-xs text-muted-foreground">
              Orders: {orderNumbers.join(", ") || "—"}
            </p>
          </div>
          <div className="text-right text-xs text-muted-foreground">
            <div>Group {group.id.slice(0, 8)}</div>
            <div>{formatDateTime(new Date().toISOString())}</div>
            <div>
              {lines.length} SKUs · {totalUnits} units
            </div>
          </div>
        </div>

        {lines.length === 0 ? (
          <p className="text-muted-foreground">
            Nothing to pick — no active orders in this group.
          </p>
        ) : (
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b text-left">
                <th className="py-1.5 pr-2 font-semibold">Bin</th>
                <th className="py-1.5 pr-2 font-semibold">Product</th>
                <th className="py-1.5 pr-2 font-semibold">SKU</th>
                <th className="py-1.5 pr-2 text-right font-semibold">Qty</th>
                <th className="w-16 py-1.5 text-center font-semibold">Picked</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={i} className="border-b">
                  <td className="py-1.5 pr-2 font-semibold tabular-nums">
                    {l.bin ?? "—"}
                  </td>
                  <td className="py-1.5 pr-2 font-medium">{l.name}</td>
                  <td className="py-1.5 pr-2 tabular-nums text-muted-foreground">
                    {l.sku ?? "—"}
                  </td>
                  <td className="py-1.5 pr-2 text-right tabular-nums">
                    {l.qty}
                  </td>
                  <td className="py-1.5 text-center">☐</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  )
}
