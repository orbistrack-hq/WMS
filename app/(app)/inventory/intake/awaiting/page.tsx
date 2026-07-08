import Link from "next/link"
import { ArrowLeft, PackageOpen } from "lucide-react"

import { createClient } from "@/lib/supabase/server"
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
import { formatGrams, formatDateTime } from "@/lib/format"

export const dynamic = "force-dynamic"

// FB-5: every parent SKU with undelegated grams sitting in the central pool,
// so the team can come back and allocate later. Reads the central report view
// (per product, no site) added in migration 0043.
type Row = {
  product_id: string
  product_name: string | null
  available_grams: number | string
  allocated_grams: number | string
  updated_at: string
}

export default async function AwaitingAllocationPage() {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from("parent_inventory_report")
    .select("product_id, product_name, available_grams, allocated_grams, updated_at")
    .gt("available_grams", 0)
    .order("product_name")

  const rows = (data ?? []) as unknown as Row[]

  return (
    <>
      <Link
        href="/inventory/intake"
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> Intake
      </Link>

      <h1 className="mb-1 text-2xl font-semibold tracking-tight">
        Awaiting allocation
      </h1>
      <p className="mb-6 text-sm text-muted-foreground">
        Parent SKUs with stock in central inventory that hasn&apos;t been
        delegated to a store yet. Allocate it whenever you&apos;re ready.
      </p>

      <Card>
        <CardContent className="p-0">
          {error ? (
            <p className="p-6 text-sm text-destructive">
              Could not load central inventory: {error.message}
            </p>
          ) : rows.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-16 text-center">
              <div className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
                <PackageOpen className="size-6" />
              </div>
              <p className="text-sm text-muted-foreground">
                Nothing waiting — every parent SKU&apos;s central stock has been
                allocated.
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Parent SKU</TableHead>
                  <TableHead className="text-right">Central available</TableHead>
                  <TableHead className="text-right">Allocated to date</TableHead>
                  <TableHead>Last movement</TableHead>
                  <TableHead className="w-px" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.product_id}>
                    <TableCell className="font-medium">
                      {r.product_name ?? "—"}
                    </TableCell>
                    <TableCell className="text-right font-medium tabular-nums">
                      {formatGrams(r.available_grams)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {formatGrams(r.allocated_grams)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {formatDateTime(r.updated_at)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Link
                        href={`/inventory/intake?allocate=${r.product_id}`}
                        className={buttonVariants({
                          variant: "outline",
                          size: "sm",
                        })}
                      >
                        Allocate
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </>
  )
}
