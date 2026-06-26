import Link from "next/link"
import { notFound } from "next/navigation"
import { ArrowLeft, ListChecks } from "lucide-react"

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
import { PackagingEditor, type UsageLine } from "./packaging-editor"
import { PackConfirm } from "./pack-confirm"

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
        sku: string | null
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
}

const PREPACK = new Set(["created", "picking"])

export default async function PackDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const supabase = await createClient()

  const [groupRes, typesRes] = await Promise.all([
    supabase
      .from("fulfillment_groups")
      .select(
        `id, status, packing_notes,
         customer:customers(name),
         site:sites(name),
         orders(id, order_number, status,
           order_line_items(id, quantity,
             child_sku:child_skus(sku, product:products(name)))),
         packaging_usage(id, quantity, unit_cost_snapshot,
           packaging_type:packaging_types(name, kind))`,
      )
      .eq("id", id)
      .maybeSingle(),
    supabase
      .from("packaging_types")
      .select("id, name, kind, unit_cost")
      .eq("is_active", true)
      .order("kind"),
  ])

  if (!groupRes.data) notFound()
  const group = groupRes.data as unknown as GroupDetail

  const needsPacking = group.orders.some((o) => PREPACK.has(o.status))

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

  return (
    <>
      <div className="mb-4 flex items-center justify-between">
        <Link
          href="/packing"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" /> Packing queue
        </Link>
        <Link
          href={`/packing/${id}/pick-list`}
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          <ListChecks data-icon="inline-start" /> Pick list
        </Link>
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
              />
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
              />
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  )
}
