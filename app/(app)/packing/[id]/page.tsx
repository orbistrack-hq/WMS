import Link from "next/link"
import { notFound } from "next/navigation"
import { ArrowLeft, ClipboardCheck, ListChecks } from "lucide-react"

import { createClient } from "@/lib/supabase/server"
import { Badge } from "@/components/ui/badge"
import { buttonVariants } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { STATUS_BADGE, type OrderStatus } from "@/lib/orders/types"
import { aggregatePickLines, type PickOrderRow } from "@/lib/packing/aggregate"
import { computeOrderPackaging } from "@/lib/packing/packaging-rules"
import { loadPackagingConfig } from "@/lib/packing/load-packaging-config"
import type { ShipmentRow, ShipmentStatus } from "@/lib/shipping/types"
import {
  PackagingEditor,
  type NoWeightLine,
  type UsageLine,
} from "./packaging-editor"
import { PackConfirm, type PackScanItem } from "./pack-confirm"
import { ShippingEditor } from "./shipping-editor"

export const dynamic = "force-dynamic"

type GroupDetail = {
  id: string
  status: string
  packing_notes: string | null
  customer: { name: string | null } | null
  site: { name: string | null } | null
  orders: {
    id: string
    order_number: string
    status: OrderStatus
    order_line_items: {
      id: string
      quantity: number
      child_sku: {
        id: string
        sku: string | null
        bin_location: string | null
        barcode: string | null
        grams_per_unit: number | string | null
        variant_label: string | null
        product: { name: string | null } | null
      } | null
    }[]
  }[]
  packaging_usage: {
    id: string
    quantity: number
    unit_cost_snapshot: number | string
    packaging_type: { name: string | null; kind: string | null } | null
  }[]
  shipments: {
    id: string
    carrier: string | null
    service_level: string | null
    estimated_cost: number | string | null
    actual_cost: number | string | null
    status: ShipmentStatus
    packages: {
      id: string
      tracking_number: string | null
      cost: number | string | null
      weight_grams: number | null
    }[]
  }[]
}

const PREPACK = new Set(["created", "picking"])

export default async function PackDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const supabase = await createClient()

  const [groupRes, typesRes, pickCompleteRes, operatorRes] =
    await Promise.all([
    supabase
      .from("fulfillment_groups")
      .select(
        `id, status, packing_notes,
         customer:customers(name),
         site:sites(name),
         orders(id, order_number, status,
           order_line_items(id, quantity,
             child_sku:child_skus(id, sku, bin_location, barcode, grams_per_unit, variant_label, product:products(name)))),
         packaging_usage(id, quantity, unit_cost_snapshot,
           packaging_type:packaging_types(name, kind)),
         shipments(id, carrier, service_level, estimated_cost, actual_cost, status,
           packages(id, tracking_number, cost, weight_grams))`,
      )
      .eq("id", id)
      .maybeSingle(),
    supabase
      .from("packaging_types")
      .select("id, name, kind, unit_cost")
      .eq("is_active", true)
      .order("kind"),
    supabase.rpc("pick_complete", { p_group_id: id }),
    supabase.rpc("is_operator"),
  ])

  if (!groupRes.data) notFound()
  const group = groupRes.data as unknown as GroupDetail

  const needsPacking = group.orders.some((o) => PREPACK.has(o.status))
  const pickComplete = pickCompleteRes.data === true
  const isOperator = operatorRes.data === true

  // Units to scan before packing = demand from orders still to pack.
  const toPack = group.orders.filter((o) => PREPACK.has(o.status))
  const packItems: PackScanItem[] = aggregatePickLines(
    toPack as unknown as PickOrderRow[],
  ).lines
    .filter((l) => l.childSkuId)
    .map((l) => ({
      childSkuId: l.childSkuId as string,
      sku: l.sku,
      barcode: l.barcode,
      name: l.name,
      required: l.qty,
    }))

  const usageLines: UsageLine[] = group.packaging_usage.map((u) => ({
    id: u.id,
    type_name: u.packaging_type?.name ?? "—",
    kind: u.packaging_type?.kind ?? "custom",
    quantity: u.quantity,
    unit_cost_snapshot: Number(u.unit_cost_snapshot),
  }))

  const packagingTypes = (typesRes.data ?? []).map((t) => ({
    id: t.id,
    name: t.name,
    kind: t.kind,
    unit_cost: Number(t.unit_cost),
  }))

  // FB-6: compute packaging from the weight→type map + per-order defaults
  // (migration 0046). Each unit maps to its exact-weight packaging; box, label,
  // and the vacuum bag are added once per group. Auto-applied when the group has
  // nothing recorded yet, so it can never double-count.
  const packagingConfig = await loadPackagingConfig(supabase)
  const computedPackaging = computeOrderPackaging(
    group.orders.flatMap((o) =>
      o.order_line_items.map((li) => ({
        gramsPerUnit:
          li.child_sku?.grams_per_unit == null
            ? null
            : Number(li.child_sku.grams_per_unit),
        qty: li.quantity,
      })),
    ),
    packagingConfig.weightRules,
    packagingConfig.orderDefaults,
  )
  const suggestedPackaging =
    usageLines.length === 0
      ? computedPackaging.lines.map((l) => ({
          typeId: l.typeId,
          typeName: l.typeName,
          kind: l.kind,
          qty: l.qty,
        }))
      : []

  // Lines whose child SKU carries no weight AND no variant label — packaging
  // couldn't be auto-filled for them (a labelled null-weight item, e.g. "Ounce
  // Special", is an intentional non-weight variant and is left out). Aggregated
  // per child SKU across the group's orders so the packer sees exactly which
  // SKUs to fix, then re-run "Top up from weight".
  const noWeightMap = new Map<string, NoWeightLine>()
  for (const o of group.orders) {
    for (const li of o.order_line_items) {
      const cs = li.child_sku
      if (!cs) continue
      if (cs.grams_per_unit != null) continue
      if (cs.variant_label) continue
      const existing = noWeightMap.get(cs.id)
      if (existing) existing.qty += li.quantity
      else
        noWeightMap.set(cs.id, {
          childSkuId: cs.id,
          name: cs.product?.name ?? "—",
          sku: cs.sku,
          qty: li.quantity,
        })
    }
  }
  const noWeightLines = [...noWeightMap.values()]

  const num = (v: number | string | null) =>
    v === null || v === "" ? null : Number(v)

  const shipments: ShipmentRow[] = group.shipments.map((s) => ({
    id: s.id,
    carrier: s.carrier,
    service_level: s.service_level,
    estimated_cost: num(s.estimated_cost),
    actual_cost: num(s.actual_cost),
    status: s.status,
    packages: s.packages.map((p) => ({
      id: p.id,
      tracking_number: p.tracking_number,
      cost: num(p.cost),
      weight_grams: p.weight_grams,
    })),
  }))

  return (
    <>
      <div className="mb-4 flex items-center justify-between">
        <Link
          href="/packing"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" /> Packing queue
        </Link>
        <div className="flex items-center gap-2">
          <Link
            href={`/packing/${id}/pick-list`}
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            <ListChecks data-icon="inline-start" /> Pick list
          </Link>
          {needsPacking ? (
            <Link
              href={`/packing/${id}/pick`}
              className={buttonVariants({ size: "sm" })}
            >
              <ClipboardCheck data-icon="inline-start" /> Pick
            </Link>
          ) : null}
        </div>
      </div>

      <div className="mb-6 flex flex-wrap items-center gap-2.5">
        <h1 className="text-2xl font-semibold tracking-tight">
          {group.customer?.name ?? "Walk-in / no customer"}
        </h1>
        <span className="text-sm text-muted-foreground">
          {group.site?.name}
        </span>
        {needsPacking ? (
          <Badge variant="warning">Needs packing</Badge>
        ) : (
          <Badge variant="success">Packed</Badge>
        )}
        {group.orders.length > 1 ? (
          <Badge variant="info">{group.orders.length} combined</Badge>
        ) : null}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-4 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>To pack</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {group.orders.map((o) => {
                const badge = STATUS_BADGE[o.status]
                return (
                  <div key={o.id} className="flex flex-col gap-2">
                    <div className="flex items-center gap-2">
                      <Link
                        href={`/orders/${o.id}`}
                        className="text-sm font-medium hover:underline"
                      >
                        {o.order_number}
                      </Link>
                      <Badge variant={badge.variant}>{badge.label}</Badge>
                    </div>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Product</TableHead>
                          <TableHead>SKU</TableHead>
                          <TableHead className="text-right">Qty</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {o.order_line_items.map((li) => (
                          <TableRow key={li.id}>
                            <TableCell className="font-medium">
                              {li.child_sku?.product?.name ?? "—"}
                            </TableCell>
                            <TableCell className="text-muted-foreground">
                              {li.child_sku?.sku ?? "—"}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {li.quantity}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )
              })}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Packaging used</CardTitle>
            </CardHeader>
            <CardContent>
              <PackagingEditor
                groupId={group.id}
                lines={usageLines}
                packagingTypes={packagingTypes}
                suggested={suggestedPackaging}
                noWeightLines={noWeightLines}
                autoApply
                enableTopUp
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Shipping</CardTitle>
            </CardHeader>
            <CardContent>
              <ShippingEditor groupId={group.id} shipments={shipments} />
            </CardContent>
          </Card>
        </div>

        <div>
          <Card>
            <CardHeader>
              <CardTitle>Confirm</CardTitle>
            </CardHeader>
            <CardContent>
              <PackConfirm
                groupId={group.id}
                initialNotes={group.packing_notes}
                needsPacking={needsPacking}
                pickComplete={pickComplete}
                items={packItems}
                isOperator={isOperator}
              />
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  )
}
