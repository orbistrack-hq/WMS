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

export const dynamic = "force-dynamic"

type Row = {
  id: string
  total_grams: number | string
  created_at: string
  product: { name: string | null } | { name: string | null }[] | null
  actor: { full_name: string | null } | { full_name: string | null }[] | null
}

function one<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null)
}

export default async function AllocationHistoryPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>
}) {
  const sp = await searchParams
  const page = parsePageParam(sp.page)
  const [from, to] = pageRangePlusOne(page)

  const supabase = await createClient()
  // Since FB-1 (central pool) an allocation's site is always NULL — the pool is
  // per parent SKU, not per site — so we no longer join or show it (the per-child
  // "Client site" lives on the detail page). Dropping the sites embed also clears
  // the likely cause of this list coming back empty; surface any error so a real
  // failure is visible instead of a misleading "no allocations yet".
  const { data, count, error } = await supabase
    .from("allocations")
    .select(
      // Disambiguate profiles: allocations has two FKs to profiles (actor +
      // reversed_by since migration 0034), so hint the actor FK column.
      "id, total_grams, created_at, product:products(name), actor:profiles!actor(full_name)",
      { count: "estimated" },
    )
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
        Allocation history
      </h1>

      <Card>
        <CardContent className="p-0">
          {error ? (
            <p className="p-6 text-sm text-destructive">
              Could not load allocation history: {error.message}
            </p>
          ) : rows.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">
              No allocations yet.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Parent SKU</TableHead>
                  <TableHead className="text-right">Allocated</TableHead>
                  <TableHead>By</TableHead>
                  <TableHead className="w-px" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {formatDateTime(r.created_at)}
                    </TableCell>
                    <TableCell className="font-medium">
                      {one(r.product)?.name ?? "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatGrams(r.total_grams)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {one(r.actor)?.full_name ?? "—"}
                    </TableCell>
                    <TableCell>
                      <Link
                        href={`/inventory/intake/history/${r.id}`}
                        className="text-sm font-medium text-primary hover:underline"
                      >
                        View
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <Pagination
            basePath="/inventory/intake/history"
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
