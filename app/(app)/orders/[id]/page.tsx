import Link from "next/link"
import { notFound } from "next/navigation"
import { ArrowLeft } from "lucide-react"

import { createClient } from "@/lib/supabase/server"
import { buttonVariants } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
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
import {
  STATUS_BADGE,
  CHANNEL_LABEL,
  ORDER_TYPE_LABEL,
  computeOrderTotals,
  type OrderStatus,
  type OrderChannel,
  type OrderType,
} from "@/lib/orders/types"
import { formatCurrency, formatDate, formatDateTime } from "@/lib/format"
import { OrderActions } from "./order-actions"
import { OrderPayments } from "./order-payments"

export const dynamic = "force-dynamic"

type LineItem = {
  id: string
  quantity: number
  unit_price: number | string
  discount: number | string | null
  tax: number | string | null
  child_sku: {
    sku: string | null
    product: { name: string | null } | null
  } | null
}

type OrderDetail = {
  id: string
  order_number: string
  status: OrderStatus
  on_hold: boolean
  order_type: OrderType
  channel: OrderChannel
  sale_date: string
  entered_at: string
  fulfilled_at: string | null
  cancelled_at: string | null
  notes: string | null
  group_id: string
  ship_to_name: string | null
  ship_to_address1: string | null
  ship_to_address2: string | null
  ship_to_city: string | null
  ship_to_region: string | null
  ship_to_postal: string | null
  ship_to_country: string | null
  customer: { name: string | null; email: string | null } | null
  site: { name: string | null; code: string | null } | null
  order_line_items: LineItem[]
  order_payments: {
    id: string
    amount: number | string
    method: string | null
    note: string | null
    paid_at: string
  }[]
}

export default async function OrderDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const supabase = await createClient()

  const { data } = await supabase
    .from("orders")
    .select(
      `id, order_number, status, on_hold, order_type, channel, sale_date, entered_at,
       fulfilled_at, cancelled_at, notes, group_id,
       ship_to_name, ship_to_address1, ship_to_address2, ship_to_city,
       ship_to_region, ship_to_postal, ship_to_country,
       customer:customers(name, email),
       site:sites(name, code),
       order_line_items(id, quantity, unit_price, discount, tax,
         child_sku:child_skus(sku, product:products(name))),
       order_payments(id, amount, method, note, paid_at)`,
    )
    .eq("id", id)
    .maybeSingle()

  if (!data) notFound()
  const order = data as unknown as OrderDetail

  // Candidates to combine (server-side, same customer + ship-to within 24h).
  const { data: combinableRaw } = await supabase.rpc("combinable_orders", {
    p_order_id: id,
  })
  const combinable = (
    (combinableRaw ?? []) as { id: string; order_number: string }[]
  ).map((c) => ({ id: c.id, order_number: c.order_number }))

  // Authoritative amount due / paid / balance straight from the DB view.
  const { data: summary } = await supabase
    .from("order_payment_summary")
    .select("total_due, amount_paid, balance")
    .eq("order_id", id)
    .maybeSingle()

  const badge = STATUS_BADGE[order.status]
  const { itemsSubtotal, total } = computeOrderTotals(order.order_line_items)
  const totalDue = summary ? Number(summary.total_due) : total
  const paid = summary ? Number(summary.amount_paid) : 0

  const hasShipTo =
    order.ship_to_name ||
    order.ship_to_address1 ||
    order.ship_to_city ||
    order.ship_to_postal

  return (
    <>
      <Link
        href="/orders"
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> All orders
      </Link>

      <div className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2.5">
          <h1 className="text-2xl font-semibold tracking-tight">
            {order.order_number}
          </h1>
          <Badge variant={badge.variant}>{badge.label}</Badge>
          {order.on_hold ? <Badge variant="destructive">Hold</Badge> : null}
          {order.order_type === "layaway" ? (
            <Badge variant="outline">Layaway</Badge>
          ) : null}
        </div>
        <span className="text-sm text-muted-foreground">
          Entered {formatDateTime(order.entered_at)}
        </span>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Main column */}
        <div className="flex flex-col gap-4 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Line items</CardTitle>
            </CardHeader>
            <CardContent className="px-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product</TableHead>
                    <TableHead>SKU</TableHead>
                    <TableHead className="text-right">Qty</TableHead>
                    <TableHead className="text-right">Unit</TableHead>
                    <TableHead className="text-right">Line total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {order.order_line_items.map((li) => {
                    const lineTotal =
                      Number(li.quantity) * Number(li.unit_price) -
                      Number(li.discount ?? 0) +
                      Number(li.tax ?? 0)
                    return (
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
                        <TableCell className="text-right tabular-nums">
                          {formatCurrency(li.unit_price)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatCurrency(lineTotal)}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
              <div className="flex flex-col gap-1 border-t px-4 pt-3 text-sm">
                <Row label="Items subtotal" value={formatCurrency(itemsSubtotal)} />
                {Math.abs(total - itemsSubtotal) > 0.005 ? (
                  <Row
                    label="Line discounts / tax"
                    value={formatCurrency(total - itemsSubtotal)}
                  />
                ) : null}
                <Row label="Total" value={formatCurrency(total)} emphasis />
              </div>
            </CardContent>
          </Card>

          {order.order_type === "layaway" ? (
            <Card>
              <CardHeader>
                <CardTitle>Layaway payments</CardTitle>
              </CardHeader>
              <CardContent>
                <OrderPayments
                  orderId={order.id}
                  total={totalDue}
                  paid={paid}
                  payments={order.order_payments ?? []}
                />
              </CardContent>
            </Card>
          ) : null}

          {order.notes ? (
            <Card>
              <CardHeader>
                <CardTitle>Notes</CardTitle>
              </CardHeader>
              <CardContent className="text-sm whitespace-pre-wrap text-muted-foreground">
                {order.notes}
              </CardContent>
            </Card>
          ) : null}
        </div>

        {/* Side column */}
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Actions</CardTitle>
            </CardHeader>
            <CardContent>
              <OrderActions
                orderId={order.id}
                status={order.status}
                onHold={order.on_hold}
                combinable={combinable}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 text-sm">
              <Row label="Customer" value={order.customer?.name ?? "—"} />
              <Row label="Site" value={order.site?.name ?? "—"} />
              <Row label="Channel" value={CHANNEL_LABEL[order.channel]} />
              <Row label="Type" value={ORDER_TYPE_LABEL[order.order_type]} />
              <Row label="Sale date" value={formatDate(order.sale_date)} />
              {order.fulfilled_at ? (
                <Row
                  label="Fulfilled"
                  value={formatDateTime(order.fulfilled_at)}
                />
              ) : null}
              {order.cancelled_at ? (
                <Row
                  label="Cancelled"
                  value={formatDateTime(order.cancelled_at)}
                />
              ) : null}
            </CardContent>
          </Card>

          {hasShipTo ? (
            <Card>
              <CardHeader>
                <CardTitle>Ship to</CardTitle>
              </CardHeader>
              <CardContent className="text-sm leading-relaxed text-muted-foreground">
                {order.ship_to_name ? <div>{order.ship_to_name}</div> : null}
                {order.ship_to_address1 ? (
                  <div>{order.ship_to_address1}</div>
                ) : null}
                {order.ship_to_address2 ? (
                  <div>{order.ship_to_address2}</div>
                ) : null}
                <div>
                  {[order.ship_to_city, order.ship_to_region, order.ship_to_postal]
                    .filter(Boolean)
                    .join(", ")}
                </div>
                {order.ship_to_country ? (
                  <div>{order.ship_to_country}</div>
                ) : null}
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  )
}

function Row({
  label,
  value,
  emphasis,
}: {
  label: string
  value: string
  emphasis?: boolean
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={
          emphasis ? "font-semibold tabular-nums" : "tabular-nums text-right"
        }
      >
        {value}
      </span>
    </div>
  )
}
