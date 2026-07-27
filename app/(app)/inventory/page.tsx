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
import { cn } from "@/lib/utils"
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
  page?: string
}

// Default (non-low-stock) inventory list is paginated so a large catalog is
// never silently truncated. Previously the whole list was capped at 1000 rows
// with no paging, so SKUs past 1000 vanished and the footer totals (incl. cost
// valuation) were understated with no warning.
const PAGE_SIZE = 100

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

  const page = Math.max(1, Number(sp.page ?? "1") || 1)
  const from = (page - 1) * PAGE_SIZE

  function buildQuery(cols: string, withLowStockFilter: boolean) {
    let q = supabase
      .from("inventory_report")
      .select(cols)
      .order("product_name")
    if (sp.site) q = q.eq("site_id", sp.site)
    // "0 stock only" wins over "hide zero" when both are somehow set.
    if (sp.zeroOnly === "1") q = q.eq("on_hand", 0)
    else if (sp.hideZero === "1") q = q.gt("on_hand", 0)
    if (withLowStockFilter) q = q.eq("is_low", true)
    if (sp.q) q = q.or(`product_name.ilike.%${sp.q}%,sku.ilike.%${sp.q}%`)
    return q
  }

  // Display window: the low-stock view shows its (small, is_low-bounded) full
  // set; the default list pages so a large catalog is never truncated.
  const windowed = (cols: string, withLowStockFilter: boolean) => {
    const q = buildQuery(cols, withLowStockFilter)
    return lowStockOnly ? q.limit(1000) : q.range(from, from + PAGE_SIZE - 1)
  }

  let { data, error } = await windowed(LOW_STOCK_COLS, lowStockOnly)

  // 42703 = undefined_column: the migration hasn't landed. Degrade gracefully —
  // re-query the legacy columns so the screen still works; low-stock stays
  // dormant until the migration is applied.
  let lowStockReady = true
  if (error?.code === "42703") {
    lowStockReady = false
    ;({ data, error } = await windowed(LEGACY_COLS, false))
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

  // Accurate grand totals + SKU count over the FULL filtered set — batched so a
  // large catalog isn't understated by the page window. Only the default list
  // shows the footer (the low-stock view renders its own component). A DB
  // aggregate RPC would be lighter; kept app-side here to avoid a migration.
  const totals = { on_hand: 0, available: 0, reserved: 0, layby: 0, value: 0 }
  let totalCount = 0
  if (!lowStockOnly && !error) {
    const BATCH = 1000
    const cols = lowStockReady ? LOW_STOCK_COLS : LEGACY_COLS
    for (let offset = 0; ; offset += BATCH) {
      const { data: batch, error: be } = await buildQuery(cols, false).range(
        offset,
        offset + BATCH - 1,
      )
      if (be || !batch || batch.length === 0) break
      for (const r of batch as unknown as InventoryRow[]) {
        totals.on_hand += r.on_hand
        totals.available += r.available
        totals.reserved += r.reserved
        totals.layby += r.layby
        totals.value += Number(r.value_at_cost)
      }
      totalCount += batch.length
      if (batch.length < BATCH) break
    }
  }
  const hasMore = !lowStockOnly && from + rows.length < totalCount

  // Page link that preserves the current filters.
  const pageHref = (n: number) => {
    const params = new URLSearchParams()
    if (sp.q) params.set("q", sp.q)
    if (sp.site) params.set("site", sp.site)
    if (sp.hideZero) params.set("hideZero", sp.hideZero)
    if (sp.zeroOnly) params.set("zeroOnly", sp.zeroOnly)
    params.set("page", String(n))
    return `/inventory?${params.toString()}`
  }

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
        <div className="flex flex-col gap-3">
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
                  {/* Reserved/layby link straight to the SKU's "Committed
                      stock" card, so the packer's next question — WHICH orders
                      are holding this? — is one click away. */}
                  <TableCell className="text-right tabular-nums">
                    {r.reserved > 0 ? (
                      <Link
                        href={`/inventory/${r.child_sku_id}#commitments`}
                        title="See the orders holding this stock"
                      >
                        <Badge variant="info">{r.reserved}</Badge>
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">0</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {r.layby > 0 ? (
                      <Link
                        href={`/inventory/${r.child_sku_id}#commitments`}
                        title="See the layaway orders behind this"
                      >
                        <Badge variant="warning">{r.layby}</Badge>
                      </Link>
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
                  {totalCount} SKU{totalCount === 1 ? "" : "s"}
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
        {page > 1 || hasMore ? (
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">
              Showing {from + 1}–{from + rows.length} of {totalCount}
            </span>
            <div className="flex gap-2">
              <Link
                aria-disabled={page <= 1}
                href={pageHref(page - 1)}
                className={cn(
                  buttonVariants({ variant: "outline", size: "sm" }),
                  page <= 1 && "pointer-events-none opacity-50",
                )}
              >
                Previous
              </Link>
              <Link
                aria-disabled={!hasMore}
                href={pageHref(page + 1)}
                className={cn(
                  buttonVariants({ variant: "outline", size: "sm" }),
                  !hasMore && "pointer-events-none opacity-50",
                )}
              >
                Next
              </Link>
            </div>
          </div>
        ) : null}
        </div>
      )}
    </>
  )
}
