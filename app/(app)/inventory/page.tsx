import Link from "next/link"
import { Boxes, Layers } from "lucide-react"

import { createClient } from "@/lib/supabase/server"
import { PageHeader } from "@/components/page-header"
import { Badge } from "@/components/ui/badge"
import { buttonVariants } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { formatCurrency } from "@/lib/format"
import { childDisplayName } from "@/lib/catalog/weight"
import { InventoryFilters } from "./inventory-filters"
import { LowStockManager, type LowStockRow } from "./low-stock-manager"

export const dynamic = "force-dynamic"

type SearchParams = {
  q?: string
  site?: string
  hideZero?: string
  lowStock?: string
  zeroOnly?: string
}

type InventoryRow = {
  child_sku_id: string
  site_id: string
  site_name: string | null
  product_name: string | null
  variant_label: string | null
  grams_per_unit: number | string | null
  sku: string | null
  on_hand: number
  available: number
  reserved: number
  layby: number
  cost: number | string
  value_at_cost: number | string
  low_stock_threshold: number | null
  effective_low_stock_threshold: number
  is_low: boolean
}

export default async function InventoryPage({
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

  const lowStockOnly = sp.lowStock === "1"

  // Low-stock columns (0079) may not exist yet if the app deploys before the
  // migration lands. Build the query against a chosen column set + low-stock
  // filter, so we can retry without those columns instead of hard-failing.
  const LEGACY_COLS = `child_sku_id, site_id, site_name, product_name, variant_label,
       grams_per_unit, sku, on_hand, available, reserved, layby, cost, value_at_cost`
  const LOW_STOCK_COLS = `${LEGACY_COLS}, low_stock_threshold, effective_low_stock_threshold, is_low`

  function buildQuery(cols: string, withLowStockFilter: boolean) {
    let q = supabase
      .from("inventory_report")
      .select(cols)
      .order("product_name")
      .limit(1000)
    if (sp.site) q = q.eq("site_id", sp.site)
    // "0 stock only" wins over "hide zero" when both are somehow set.
    if (sp.zeroOnly === "1") q = q.eq("on_hand", 0)
    else if (sp.hideZero === "1") q = q.gt("on_hand", 0)
    if (withLowStockFilter) q = q.eq("is_low", true)
    if (sp.q) q = q.or(`product_name.ilike.%${sp.q}%,sku.ilike.%${sp.q}%`)
    return q
  }

  let { data, error } = await buildQuery(LOW_STOCK_COLS, lowStockOnly)

  // 42703 = undefined_column: the migration hasn't landed. Degrade gracefully —
  // re-query the legacy columns so the screen still works; low-stock stays
  // dormant until the migration is applied.
  let lowStockReady = true
  if (error?.code === "42703") {
    lowStockReady = false
    ;({ data, error } = await buildQuery(LEGACY_COLS, false))
  }

  // Default the low-stock fields so rows are uniform whether or not the columns
  // came back — keep the real values when present, fall back when undefined.
  const rows = ((data ?? []) as unknown as InventoryRow[]).map((r) => ({
    ...r,
    low_stock_threshold: r.low_stock_threshold ?? null,
    effective_low_stock_threshold: r.effective_low_stock_threshold ?? 0,
    is_low: r.is_low ?? false,
  })) as InventoryRow[]

  // Ops-only controls (bulk threshold editing, default). Mirrors the banner gate.
  // Only queried in the low-stock view, and only once the migration has landed.
  const { data: isOps } =
    lowStockOnly && lowStockReady
      ? await supabase.rpc("is_operator")
      : { data: false }
  const { data: defaultRow } =
    lowStockOnly && lowStockReady
      ? await supabase
          .from("app_settings")
          .select("int_value")
          .eq("key", "low_stock_default")
          .maybeSingle()
      : { data: null }
  const defaultThreshold = (defaultRow?.int_value as number | undefined) ?? 5

  const totals = rows.reduce(
    (acc, r) => {
      acc.on_hand += r.on_hand
      acc.available += r.available
      acc.reserved += r.reserved
      acc.layby += r.layby
      acc.value += Number(r.value_at_cost)
      return acc
    },
    { on_hand: 0, available: 0, reserved: 0, layby: 0, value: 0 },
  )

  return (
    <>
      <PageHeader
        title="Inventory"
        description="Real-time stock per child SKU per location — available vs. reserved."
        action={
          <Link
            href="/inventory/by-parent"
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            <Layers /> Group by parent
          </Link>
        }
      />

      <InventoryFilters sites={sites ?? []} />

      {error ? (
        <Card>
          <CardContent className="py-8 text-sm text-destructive">
            Could not load inventory: {error.message}
          </CardContent>
        </Card>
      ) : lowStockOnly && !lowStockReady ? (
        <Card>
          <CardContent className="py-8 text-sm text-muted-foreground">
            Low-stock alerts aren&apos;t active yet — the database migration
            hasn&apos;t been applied. This turns on automatically once it lands.
          </CardContent>
        </Card>
      ) : lowStockOnly ? (
        <LowStockManager
          rows={rows as unknown as LowStockRow[]}
          defaultThreshold={defaultThreshold}
          canManage={isOps === true}
        />
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <div className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <Boxes className="size-6" />
            </div>
            <p className="text-sm text-muted-foreground">
              No stock rows match these filters.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead>SKU</TableHead>
                <TableHead>Site</TableHead>
                <TableHead className="text-right">On hand</TableHead>
                <TableHead className="text-right">Available</TableHead>
                <TableHead className="text-right">Reserved</TableHead>
                <TableHead className="text-right">Layby</TableHead>
                <TableHead className="text-right">Value</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.child_sku_id}>
                  <TableCell className="font-medium">
                    <Link
                      href={`/inventory/${r.child_sku_id}`}
                      className="hover:underline"
                    >
                      {childDisplayName(
                        r.product_name,
                        r.variant_label,
                        r.grams_per_unit,
                      )}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {r.sku ?? "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {r.site_name ?? "—"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {r.is_low ? (
                      <Badge
                        variant={r.on_hand <= 0 ? "destructive" : "warning"}
                        title={`Low — alert at ${r.effective_low_stock_threshold}`}
                      >
                        {r.on_hand}
                      </Badge>
                    ) : (
                      r.on_hand
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums font-medium">
                    {r.available}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {r.reserved > 0 ? (
                      <Badge variant="info">{r.reserved}</Badge>
                    ) : (
                      <span className="text-muted-foreground">0</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {r.layby > 0 ? (
                      <Badge variant="warning">{r.layby}</Badge>
                    ) : (
                      <span className="text-muted-foreground">0</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {formatCurrency(r.value_at_cost)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
            <tfoot className="border-t bg-muted/40">
              <TableRow className="hover:bg-transparent">
                <TableCell className="font-medium" colSpan={3}>
                  {rows.length} SKU{rows.length === 1 ? "" : "s"}
                </TableCell>
                <TableCell className="text-right tabular-nums font-medium">
                  {totals.on_hand}
                </TableCell>
                <TableCell className="text-right tabular-nums font-medium">
                  {totals.available}
                </TableCell>
                <TableCell className="text-right tabular-nums font-medium">
                  {totals.reserved}
                </TableCell>
                <TableCell className="text-right tabular-nums font-medium">
                  {totals.layby}
                </TableCell>
                <TableCell className="text-right tabular-nums font-medium">
                  {formatCurrency(totals.value)}
                </TableCell>
              </TableRow>
            </tfoot>
          </Table>
        </Card>
      )}
    </>
  )
}
