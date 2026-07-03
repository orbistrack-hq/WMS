import Link from "next/link"
import { notFound } from "next/navigation"
import { ArrowLeft } from "lucide-react"

import { createClient } from "@/lib/supabase/server"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
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

function one<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null)
}

type Named = { name: string | null }
type LineRow = {
  units: number
  grams: number | string
  grams_per_unit: number | string
  child:
    | { variant_label: string | null; sku: string | null; site: Named | null }
    | { variant_label: string | null; sku: string | null; site: Named | null }[]
    | null
}

export default async function AllocationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const supabase = await createClient()

  const [allocRes, linesRes] = await Promise.all([
    supabase
      .from("allocations")
      .select(
        "id, total_grams, note, created_at, product:products(name), site:sites(name), actor:profiles(full_name)",
      )
      .eq("id", id)
      .maybeSingle(),
    supabase
      .from("allocation_lines")
      .select(
        "units, grams, grams_per_unit, child:child_skus(variant_label, sku, site:sites(name))",
      )
      .eq("allocation_id", id),
  ])

  if (!allocRes.data) notFound()
  const a = allocRes.data as unknown as {
    total_grams: number | string
    note: string | null
    created_at: string
    product: Named | Named[] | null
    site: Named | Named[] | null
    actor: { full_name: string | null } | { full_name: string | null }[] | null
  }
  const lines = (linesRes.data ?? []) as unknown as LineRow[]

  return (
    <>
      <Link
        href="/inventory/intake/history"
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> Allocation history
      </Link>

      <h1 className="mb-1 text-2xl font-semibold tracking-tight">
        {one(a.product)?.name ?? "—"}
      </h1>
      <p className="mb-6 text-sm text-muted-foreground">
        {formatDateTime(a.created_at)} · {one(a.site)?.name ?? "—"} ·{" "}
        {one(a.actor)?.full_name ?? "—"}
      </p>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Allocated child SKUs</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Client site</TableHead>
                  <TableHead>Weight</TableHead>
                  <TableHead>SKU</TableHead>
                  <TableHead className="text-right">Units</TableHead>
                  <TableHead className="text-right">Grams</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.map((l, i) => {
                  const child = one(l.child)
                  return (
                    <TableRow key={i}>
                      <TableCell>{child?.site?.name ?? "—"}</TableCell>
                      <TableCell className="tabular-nums">
                        {child?.variant_label ?? `${Number(l.grams_per_unit)}g`}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {child?.sku ?? "—"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {l.units}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatGrams(l.grams)}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Summary</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Total allocated</span>
                <span className="font-medium tabular-nums">
                  {formatGrams(a.total_grams)}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Child SKUs</span>
                <span className="font-medium tabular-nums">{lines.length}</span>
              </div>
              {a.note ? (
                <div className="flex flex-col gap-1 border-t border-border pt-3">
                  <span className="text-muted-foreground">Note</span>
                  <span>{a.note}</span>
                </div>
              ) : null}
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  )
}
