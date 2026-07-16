import Link from "next/link"
import { notFound } from "next/navigation"
import { ArrowLeft } from "lucide-react"

import { createClient } from "@/lib/supabase/server"
import { formatDateTime } from "@/lib/format"
import { aggregatePickLines, type PickOrderRow } from "@/lib/packing/aggregate"
import { PrintButton } from "./print-button"

export const dynamic = "force-dynamic"

type PickGroup = {
  id: string
  customer: { name: string | null } | null
  site: { name: string | null } | null
  orders: PickOrderRow[]
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
       orders(order_number, status, on_hold,
         order_line_items(quantity,
           child_sku:child_skus(id, sku, bin_location, product:products(name))))`,
    )
    .eq("id", id)
    .maybeSingle()

  if (!data) notFound()
  const group = data as unknown as PickGroup

  // Aggregate across the group's active orders, sorted into a walking route.
  const { lines, orderNumbers, totalUnits } = aggregatePickLines(group.orders)

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
