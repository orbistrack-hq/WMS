import Link from "next/link"
import { Plus, ClipboardList, ChevronLeft, ChevronRight } from "lucide-react"

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
  page?: string
}

const PAGE_SIZE = 50
// Computed columns (total/items) can't be ordered in Postgres, so for those
// sorts we pull a capped window, sort it in JS, then slice the page. Large
// enough for this team's volume; DB-sortable columns paginate without a cap.
const COMPUTED_SORT_CAP = 1000

const ORDERS_SELECT = `id, order_number, status, on_hold, backordered, order_type, channel, sale_date, entered_at,
   group_id,
   customer:customers(name),
   site:sites(name, code),
   order_line_items(quantity, unit_price, discount, tax)`

function pageHref(sp: SearchParams, p: number): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(sp)) {
    if (k !== "page" && v) params.set(k, v)
  }
  params.set("page", String(p))
  return `/orders?${params.toString()}`
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
  backordered: boolean
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
  const isComputedSort = sort === "total" || sort === "items"
  const page = Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1)

  // Shared filters - applied identically whichever sort path we take.
  let base = supabase
    .from("orders")
    .select(ORDERS_SELECT, isComputedSort ? undefined : { count: "exact" })
  if (sp.status) base = base.eq("status", sp.status)
  if (sp.site) base = base.eq("site_id", sp.site)
  if (sp.channel) base = base.eq("channel", sp.channel)
  if (sp.hold === "true") base = base.eq("on_hold", true)
  if (sp.hold === "false") base = base.eq("on_hold", false)
  if (sp.q) base = base.ilike("order_number", `%${sp.q}%`)

  const withTotals = (o: OrderRow) => ({
    ...o,
    ...computeOrderTotals(o.order_line_items),
  })

  let orders: (OrderRow & ReturnType<typeof computeOrderTotals>)[] = []
  let totalCount = 0
  let error: { message: string } | null = null

  if (isComputedSort) {
    // Pull a capped window, attach totals, sort in JS, then slice the page.
    const { data, error: e } = await base
      .order("entered_at", { ascending: false })
      .limit(COMPUTED_SORT_CAP)
    error = e
    const all = ((data ?? []) as unknown as OrderRow[]).map(withTotals)
    const sign = dir === "asc" ? 1 : -1
    const key = sort === "items" ? "itemCount" : "total"
    all.sort((a, b) => sign * (a[key] - b[key]))
    totalCount = all.length
    const from = (page - 1) * PAGE_SIZE
    orders = all.slice(from, from + PAGE_SIZE)
  } else {
    // DB-sortable column: order + range straight in Postgres with exact count.
    const from = (page - 1) * PAGE_SIZE
    const {
      data,
      error: e,
      count,
    } = await base
      .order(dbSort, { ascending: dir === "asc" })
      .range(from, from + PAGE_SIZE - 1)
    error = e
    orders = ((data ?? []) as unknown as OrderRow[]).map(withTotals)
    totalCount = count ?? 0
  }

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE))
  const rangeStart = totalCount === 0 ? 0 : (page - 1) * PAGE_SIZE + 1
  const rangeEnd = Math.min(page * PAGE_SIZE, totalCount)

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
                        {o.backordered ? (
                          <Badge variant="warning">Backordered</Badge>
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
          {totalPages > 1 ? (
            <div className="flex items-center justify-between border-t px-4 py-3 text-sm">
              <span className="text-muted-foreground tabular-nums">
                {rangeStart}-{rangeEnd} of {totalCount}
                {isComputedSort && totalCount === COMPUTED_SORT_CAP ? "+" : ""}
              </span>
              <div className="flex items-center gap-2">
                {page > 1 ? (
                  <Link
                    href={pageHref(sp, page - 1)}
                    className={buttonVariants({ variant: "outline", size: "sm" })}
                  >
                    <ChevronLeft data-icon="inline-start" /> Prev
                  </Link>
                ) : (
                  <span
                    className={buttonVariants({ variant: "outline", size: "sm" })}
                    aria-disabled
                    style={{ opacity: 0.5, pointerEvents: "none" }}
                  >
                    <ChevronLeft data-icon="inline-start" /> Prev
                  </span>
                )}
                <span className="tabular-nums text-muted-foreground">
                  Page {page} of {totalPages}
                </span>
                {page < totalPages ? (
                  <Link
                    href={pageHref(sp, page + 1)}
                    className={buttonVariants({ variant: "outline", size: "sm" })}
                  >
                    Next <ChevronRight data-icon="inline-end" />
                  </Link>
                ) : (
                  <span
                    className={buttonVariants({ variant: "outline", size: "sm" })}
                    aria-disabled
                    style={{ opacity: 0.5, pointerEvents: "none" }}
                  >
                    Next <ChevronRight data-icon="inline-end" />
                  </span>
                )}
              </div>
            </div>
          ) : null}
        </Card>
      )}
    </>
  )
}
