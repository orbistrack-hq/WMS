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
import { InventoryFilters } from "./inventory-filters"

export const dynamic = "force-dynamic"

type SearchParams = { q?: string; site?: string; hideZero?: string }

type InventoryRow = {
  child_sku_id: string
  site_id: string
  site_name: string | null
  product_name: string | null
  sku: string | null
  on_hand: number
  available: number
  reserved: number
  layby: number
  cost: number | string
  value_at_cost: number | string
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

  let query = supabase
    .from("inventory_report")
    .select(
      `child_sku_id, site_id, site_name, product_name, sku,
       on_hand, available, reserved, layby, cost, value_at_cost`,
    )
    .order("product_name")
    .limit(1000)

  if (sp.site) query = query.eq("site_id", sp.site)
  if (sp.hideZero === "1") query = query.gt("on_hand", 0)
  if (sp.q) query = query.or(`product_name.ilike.%${sp.q}%,sku.ilike.%${sp.q}%`)

  const { data, error } = await query
  const rows = (data ?? []) as unknown as InventoryRow[]

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
                      {r.product_name ?? "—"}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {r.sku ?? "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {r.site_name ?? "—"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {r.on_hand}
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
