import Link from "next/link"
import { ArrowLeft } from "lucide-react"

import { createClient } from "@/lib/supabase/server"
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
  site: { name: string | null } | { name: string | null }[] | null
  actor: { full_name: string | null } | { full_name: string | null }[] | null
}

function one<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null)
}

export default async function AllocationHistoryPage() {
  const supabase = await createClient()
  const { data } = await supabase
    .from("allocations")
    .select(
      "id, total_grams, created_at, product:products(name), site:sites(name), actor:profiles(full_name)",
    )
    .order("created_at", { ascending: false })
    .limit(200)

  const rows = (data ?? []) as unknown as Row[]

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
          {rows.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">
              No allocations yet.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Parent SKU</TableHead>
                  <TableHead>Site</TableHead>
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
                    <TableCell>{one(r.site)?.name ?? "—"}</TableCell>
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
        </CardContent>
      </Card>
    </>
  )
}
