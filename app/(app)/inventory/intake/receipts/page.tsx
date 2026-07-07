import Link from "next/link"
import { ArrowLeft } from "lucide-react"

import { createClient } from "@/lib/supabase/server"
import { Pagination } from "@/components/pagination"
import {
  DEFAULT_PAGE_SIZE,
  parsePageParam,
  pageRangePlusOne,
} from "@/lib/pagination"
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

import { ReverseIntakeButton } from "./reverse-intake-button"

export const dynamic = "force-dynamic"

function one<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null)
}

type Named = { name: string | null }
type Row = {
  id: string
  delta_grams: number | string
  batch_no: string | null
  note: string | null
  created_at: string
  reversed_at: string | null
  product: Named | Named[] | null
  site: Named | Named[] | null
  actor: { full_name: string | null } | { full_name: string | null }[] | null
}

export default async function IntakeReceiptsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>
}) {
  const sp = await searchParams
  const page = parsePageParam(sp.page)
  const [from, to] = pageRangePlusOne(page)

  const supabase = await createClient()
  // Bulk intakes are parent_inventory_ledger rows with reason 'intake'.
  const { data, count } = await supabase
    .from("parent_inventory_ledger")
    .select(
      "id, delta_grams, batch_no, note, created_at, reversed_at, product:products(name), site:sites(name), actor:profiles(full_name)",
      { count: "estimated" },
    )
    .eq("reason", "intake")
    .order("created_at", { ascending: false })
    .range(from, to)

  const fetched = (data ?? []) as unknown as Row[]
  const hasMore = fetched.length > DEFAULT_PAGE_SIZE
  const rows = fetched.slice(0, DEFAULT_PAGE_SIZE)

  return (
    <>
      <Link
        href="/inventory/intake"
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> Intake
      </Link>

      <h1 className="mb-6 text-2xl font-semibold tracking-tight">
        Intake receipts
      </h1>

      <Card>
        <CardContent className="p-0">
          {rows.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">No intakes yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Parent SKU</TableHead>
                  <TableHead>Site</TableHead>
                  <TableHead>Batch</TableHead>
                  <TableHead className="text-right">Grams</TableHead>
                  <TableHead>By</TableHead>
                  <TableHead className="text-right">Reverse</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="whitespace-nowrap tabular-nums">
                      {formatDateTime(r.created_at)}
                    </TableCell>
                    <TableCell>{one(r.product)?.name ?? "—"}</TableCell>
                    <TableCell>{one(r.site)?.name ?? "—"}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {r.batch_no ?? "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatGrams(r.delta_grams)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {one(r.actor)?.full_name ?? "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      {r.reversed_at ? (
                        <span className="text-xs text-muted-foreground">
                          Reversed {formatDateTime(r.reversed_at)}
                        </span>
                      ) : (
                        <ReverseIntakeButton ledgerId={r.id} />
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <Pagination
            basePath="/inventory/intake/receipts"
            params={sp}
            page={page}
            hasMore={hasMore}
            pageRows={rows.length}
            approxTotal={count ?? null}
          />
        </CardContent>
      </Card>
    </>
  )
}
