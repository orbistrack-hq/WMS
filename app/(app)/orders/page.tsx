import Link from "next/link"
import { Plus, ClipboardList } from "lucide-react"

import { createClient } from "@/lib/supabase/server"
import { PageHeader } from "@/components/page-header"
import { buttonVariants } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
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
  computeOrderTotals,
  type OrderStatus,
  type OrderChannel,
} from "@/lib/orders/types"
import { formatCurrency, formatDate } from "@/lib/format"
import { OrdersFilters } from "./orders-filters"

export const dynamic = "force-dynamic"

type SearchParams = {
  q?: string
  status?: string
  site?: string
  channel?: string
  hold?: string
  sort?: string
  dir?: string
}

// Columns Postgres can order directly. Computed columns (total/items) are
// sorted in JS after the totals are derived, below.
const DB_SORTS = new Set([
  "entered_at",
  "sale_date",
  "order_number",
  "status",
])

type OrderRow = {
  id: string
  order_number: string
  status: OrderStatus
  on_hold: boolean
  order_type: "standard" | "layaway"
  channel: OrderChannel
  sale_date: string
  entered_at: string
  group_id: string
  customer: { name: string | null } | null
  site: { name: string | null; code: string | null } | null
  order_line_items: {
    quantity: number
    unit_price: number | string
    discount: number | string | null
    tax: number | string | null
  }[]
}

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const sp = await searchParams
  const supabase = await createClient()

  const { data: sites } = await supabase
    .from("sites")
    .select("id, name")
    .order("name")

  const sort = sp.sort ?? "entered_at"
  const dir: "asc" | "desc" = sp.dir === "asc" ? "asc" : "desc"
  const dbSort = DB_SORTS.has(sort) ? sort : "entered_at"

  let query = supabase
    .from("orders")
    .select(
      `id, order_number, status, on_hold, order_type, channel, sale_date, entered_at,
       group_id,
       customer:customers(name),
       site:sites(name, code),
       order_line_items(quantity, unit_price, discount, tax)`,
    )
    .order(dbSort, { ascending: dir === "asc" })
    .limit(200)

  if (sp.status) query = query.eq("status", sp.status)
  if (sp.site) query = query.eq("site_id", sp.site)
  if (sp.channel) query = query.eq("channel", sp.channel)
  if (sp.hold === "true") query = query.eq("on_hold", true)
  if (sp.hold === "false") query = query.eq("on_hold", false)
  if (sp.q) query = query.ilike("order_number", `%${sp.q}%`)

  const { data, error } = await query

  // Attach computed totals once, then sort in JS for the computed columns.
  const orders = ((data ?? []) as unknown as OrderRow[]).map((o) => ({
    ...o,
    ...computeOrderTotals(o.order_line_items),
  }))
  if (sort === "total" || sort === "items") {
    const sign = dir === "asc" ? 1 : -1
    const key = sort === "items" ? "itemCount" : "total"
    orders.sort((a, b) => sign * (a[key] - b[key]))
  }

  return (
    <>
      <PageHeader
        title="Orders"
        description="Create and manage orders through the full status flow."
        action={
          <Link href="/orders/new" className={buttonVariants()}>
            <Plus data-icon="inline-start" /> New order
          </Link>
        }
      />

      <OrdersFilters sites={sites ?? []} />

      {error ? (
        <Card>
          <CardContent className="py-8 text-sm text-destructive">
            Could not load orders: {error.message}
          </CardContent>
        </Card>
      ) : orders.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <div className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <ClipboardList className="size-6" />
            </div>
            <p className="text-sm text-muted-foreground">
              No orders match these filters.
            </p>
            <Link
              href="/orders/new"
              className={buttonVariants({ variant: "outline" })}
            >
              <Plus data-icon="inline-start" /> Create the first order
            </Link>
          </CardContent>
        </Card>
      ) : (
        <Card className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Order</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Site</TableHead>
                <TableHead>Channel</TableHead>
                <TableHead className="text-right">Items</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead>Sale date</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {orders.map((o) => {
                const badge = STATUS_BADGE[o.status]
                const { itemCount, total } = o
                return (
                  <TableRow key={o.id}>
                    <TableCell className="font-medium">
                      <Link
                        href={`/orders/${o.id}`}
                        className="hover:underline"
                      >
                        {o.order_number}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        <Badge variant={badge.variant}>{badge.label}</Badge>
                        {o.on_hold ? (
                          <Badge variant="destructive">Hold</Badge>
                        ) : null}
                        {o.order_type === "layaway" ? (
                          <Badge variant="outline">Layaway</Badge>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {o.customer?.name ?? "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {o.site?.name ?? "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {CHANNEL_LABEL[o.channel]}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {itemCount}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCurrency(total)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDate(o.sale_date)}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </Card>
      )}
    </>
  )
}
