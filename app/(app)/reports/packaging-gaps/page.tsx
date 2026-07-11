import { createClient } from "@/lib/supabase/server"
import { PageHeader } from "@/components/page-header"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { formatCurrency } from "@/lib/format"
import { ExportButton } from "../export-button"
import { PackagingGapsFilters } from "./packaging-gaps-filters"
import {
  PackagingGapsTable,
  type PackagingType,
} from "./packaging-gaps-table"

export const dynamic = "force-dynamic"

type SearchParams = {
  from?: string
  to?: string
  site?: string
  channel?: string
}

type GapRow = {
  order_id: string
  order_number: string
  site_id: string
  site_name: string | null
  customer_name: string | null
  channel: string
  order_type: string
  group_id: string
  entered_at: string
  sale_date: string
  fulfilled_at: string | null
  line_count: number | string
  unit_count: number | string
  order_value: number | string
  group_order_count: number | string
  auto_fulfilled: boolean
}

const num = (v: number | string | null | undefined) => Number(v ?? 0)

export default async function PackagingGapsReportPage({
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

  const { data: packagingTypes } = await supabase
    .from("packaging_types")
    .select("id, name, kind, unit_cost")
    .eq("is_active", true)
    .order("kind")

  let query = supabase
    .from("orders_missing_packaging")
    .select(
      `order_id, order_number, site_id, site_name, customer_name, channel,
       order_type, group_id, entered_at, sale_date, fulfilled_at,
       line_count, unit_count, order_value, group_order_count, auto_fulfilled`,
    )
    .order("fulfilled_at", { ascending: false })
    .limit(5000)

  if (sp.from) query = query.gte("fulfilled_at", sp.from)
  if (sp.to) query = query.lte("fulfilled_at", `${sp.to}T23:59:59.999`)
  if (sp.site) query = query.eq("site_id", sp.site)
  if (sp.channel) query = query.eq("channel", sp.channel)

  const { data, error } = await query
  const rows = (data ?? []) as unknown as GapRow[]

  const totalOrders = rows.length
  const totalUnits = rows.reduce((n, r) => n + num(r.unit_count), 0)
  const totalValue = rows.reduce((n, r) => n + num(r.order_value), 0)

  const csvColumns = [
    { key: "order_number", label: "Order" },
    { key: "fulfilled_at", label: "Fulfilled at" },
    { key: "site_name", label: "Site" },
    { key: "customer_name", label: "Customer" },
    { key: "channel", label: "Channel" },
    { key: "unit_count", label: "Units" },
    { key: "order_value", label: "Order value" },
    { key: "sale_date", label: "Sale date" },
  ]

  const kpis = [
    { label: "Orders missing packaging", value: String(totalOrders) },
    { label: "Units", value: String(totalUnits) },
    { label: "Order value", value: formatCurrency(totalValue) },
  ]

  return (
    <>
      <PageHeader
        title="Packaging gaps"
        description="Fulfilled Shopify/Woo orders whose packaging was never recorded — typically auto-fulfilled by a store webhook, skipping the packing screen. Record packaging from the packing screen to clear each one and capture its cost."
        action={
          <ExportButton
            columns={csvColumns}
            rows={rows as unknown as Record<string, string | number | null>[]}
            filename="packaging-gaps.csv"
          />
        }
      />

      <PackagingGapsFilters sites={sites ?? []} />

      {error ? (
        <Card>
          <CardContent className="py-8 text-sm text-destructive">
            Could not load packaging gaps: {error.message}
            <span className="mt-1 block text-muted-foreground">
              If this view is missing, apply migration 0062
              (orders_missing_packaging).
            </span>
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-3 gap-3">
            {kpis.map((k) => (
              <Card key={k.label}>
                <CardContent className="flex flex-col gap-0.5">
                  <span className="text-xs text-muted-foreground">
                    {k.label}
                  </span>
                  <span className="text-2xl font-semibold tabular-nums">
                    {k.value}
                  </span>
                </CardContent>
              </Card>
            ))}
          </div>

          <Card className="p-0">
            <CardHeader className="px-4 pt-4">
              <CardTitle className="text-base">
                Orders needing packaging
              </CardTitle>
            </CardHeader>
            {rows.length === 0 ? (
              <CardContent className="py-8 text-sm text-muted-foreground">
                No packaging gaps — every fulfilled store order has packaging
                recorded.
              </CardContent>
            ) : (
              <PackagingGapsTable
                rows={rows}
                packagingTypes={(packagingTypes ?? []) as PackagingType[]}
              />
            )}
          </Card>
        </div>
      )}
    </>
  )
}
