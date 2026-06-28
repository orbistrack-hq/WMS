import { notFound } from "next/navigation"

import { createClient } from "@/lib/supabase/server"
import { aggregatePickLines, type PickOrderRow } from "@/lib/packing/aggregate"
import { PickRunner, type PickRow } from "./pick-runner"

export const dynamic = "force-dynamic"

type PickGroup = {
  id: string
  status: string
  customer: { name: string | null } | null
  site: { name: string | null } | null
  orders: PickOrderRow[]
}

export default async function PickPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const supabase = await createClient()

  const [{ data }, progressRes, claimRes, userRes] = await Promise.all([
    supabase
      .from("fulfillment_groups")
      .select(
        `id, status,
         customer:customers(name),
         site:sites(name),
         orders(order_number, status,
           order_line_items(quantity,
             child_sku:child_skus(id, sku, bin_location, barcode, product:products(name))))`,
      )
      .eq("id", id)
      .maybeSingle(),
    supabase
      .from("pick_progress")
      .select("child_sku_id, qty_picked, short")
      .eq("group_id", id),
    supabase
      .from("pick_claims")
      .select("picked_by, holder:profiles(full_name)")
      .eq("group_id", id)
      .maybeSingle(),
    supabase.auth.getUser(),
  ])

  if (!data) notFound()
  const group = data as unknown as PickGroup

  // Required = demand from orders still to pick (created/picking), aggregated in
  // walking-route order. Matches the server's pick_required so the runner's
  // totals and the clamp agree.
  const toPick = group.orders.filter(
    (o) => o.status === "created" || o.status === "picking",
  )
  const { lines, orderNumbers, totalUnits } = aggregatePickLines(toPick)

  const progressBySku = new Map(
    ((progressRes.data ?? []) as {
      child_sku_id: string
      qty_picked: number
      short: boolean
    }[]).map((p) => [p.child_sku_id, p]),
  )

  const rows: PickRow[] = lines.map((l) => {
    const p = l.childSkuId ? progressBySku.get(l.childSkuId) : undefined
    return {
      childSkuId: l.childSkuId,
      sku: l.sku,
      bin: l.bin,
      barcode: l.barcode,
      name: l.name,
      required: l.qty,
      qtyPicked: p?.qty_picked ?? 0,
      short: p?.short ?? false,
    }
  })

  const claim = claimRes.data as
    | { picked_by: string | null; holder: { full_name: string | null } | null }
    | null
  const userId = userRes.data.user?.id ?? null

  return (
    <PickRunner
      groupId={group.id}
      groupOpen={group.status === "open"}
      customerName={group.customer?.name ?? "Walk-in / no customer"}
      siteName={group.site?.name ?? null}
      orderNumbers={orderNumbers}
      totalUnits={totalUnits}
      rows={rows}
      initialHolderId={claim?.picked_by ?? null}
      initialHolderName={claim?.holder?.full_name ?? null}
      currentUserId={userId}
    />
  )
}
