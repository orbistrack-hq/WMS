import Link from "next/link"
import { Plus, ClipboardList } from "lucide-react"

import { createClient } from "@/lib/supabase/server"
import { PageHeader } from "@/components/page-header"
import { Pagination } from "@/components/pagination"
import { buttonVariants } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  computeOrderTotals,
  type OrderStatus,
  type OrderChannel,
} from "@/lib/orders/types"
import { OrdersFilters } from "./orders-filters"
import { OrdersTable } from "./orders-table"

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
    // Estimated count (planner estimate) instead of "exact": an exact count
    // scans every matching row on each load, which — with the entered_at sort —
    // was tipping the orders list over the statement_timeout. The page total
    // becomes approximate; Prev/Next stay correct because navigation is gated by
    // the range slice, not the count.
    .select(ORDERS_SELECT, isComputedSort ? undefined : { count: "estimated" })
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
  let approxTotal: number | null = null
  let hasMore = false
  let error: { message: string } | null = null
  const from = (page - 1) * PAGE_SIZE

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
    approxTotal = all.length
    orders = all.slice(from, from + PAGE_SIZE)
    hasMore = from + PAGE_SIZE < all.length
  } else {
    // DB-sortable column: order + range straight in Postgres. Fetch one extra
    // row to detect a next page — navigation must not depend on the estimated
    // count, which can be stale.
    const {
      data,
      error: e,
      count,
    } = await base
      .order(dbSort, { ascending: dir === "asc" })
      .range(from, from + PAGE_SIZE)
    error = e
    const rows = ((data ?? []) as unknown as OrderRow[]).map(withTotals)
    hasMore = rows.length > PAGE_SIZE
    orders = rows.slice(0, PAGE_SIZE)
    approxTotal = count ?? null
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
        <div className="flex flex-col gap-3">
          <OrdersTable
            rows={orders.map((o) => ({
              id: o.id,
              order_number: o.order_number,
              status: o.status,
              on_hold: o.on_hold,
              backordered: o.backordered,
              order_type: o.order_type,
              channel: o.channel,
              sale_date: o.sale_date,
              customerName: o.customer?.name ?? null,
              siteName: o.site?.name ?? null,
              itemCount: o.itemCount,
              total: o.total,
            }))}
          />
          {page > 1 || hasMore ? (
            <Card className="p-0">
              <Pagination
                basePath="/orders"
                params={sp}
                page={page}
                hasMore={hasMore}
                pageRows={orders.length}
                pageSize={PAGE_SIZE}
                approxTotal={approxTotal}
              />
            </Card>
          ) : null}
        </div>
      )}
    </>
  )
}
