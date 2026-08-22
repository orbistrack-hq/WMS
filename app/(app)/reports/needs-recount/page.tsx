import Link from "next/link"
import { ClipboardList } from "lucide-react"

import { createClient } from "@/lib/supabase/server"
import { PageHeader, Placeholder } from "@/components/page-header"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { formatDateTime } from "@/lib/format"

export const dynamic = "force-dynamic"

// One row per 'needs_recount' inventory_ledger entry (needs_recount_report view).
type RecountRow = {
  ledger_id: string
  child_sku_id: string
  sku: string | null
  site_id: string
  site_name: string | null
  product_name: string | null
  note: string | null
  created_at: string
}

export default async function NeedsRecountReportPage() {
  const supabase = await createClient()

  const { data } = await supabase
    .from("needs_recount_report")
    .select("ledger_id, child_sku_id, sku, site_id, site_name, product_name, note, created_at")
    .limit(500)

  const rows = (data ?? []) as unknown as RecountRow[]

  // Per-SKU: most recent flag per SKU, plus how many times it's been flagged —
  // a repeat flag on the same SKU is worth calling out (still hasn't been
  // recounted since the last one).
  const bySku = new Map<
    string,
    { key: string; sku: string | null; productName: string | null; siteName: string | null; flags: number; latest: string }
  >()
  for (const r of rows) {
    const cur = bySku.get(r.child_sku_id)
    if (!cur) {
      bySku.set(r.child_sku_id, {
        key: r.child_sku_id,
        sku: r.sku,
        productName: r.product_name,
        siteName: r.site_name,
        flags: 1,
        latest: r.created_at,
      })
    } else {
      cur.flags += 1
    }
  }
  const skuRollup = Array.from(bySku.values()).sort(
    (a, b) => new Date(b.latest).getTime() - new Date(a.latest).getTime(),
  )

  return (
    <>
      <PageHeader
        title="Needs recount"
        description="SKUs where a correction (e.g. fulfilling a cancelled-but-shipped order) couldn't be fully reflected in on-hand because it was already at zero — a sign the physical count is off."
      />

      {rows.length === 0 ? (
        <Placeholder icon={ClipboardList} title="Nothing flagged">
          No SKU currently has an outstanding recount flag.
        </Placeholder>
      ) : (
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Flagged SKUs ({skuRollup.length})</CardTitle>
            </CardHeader>
            <CardContent className="px-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product</TableHead>
                    <TableHead>SKU</TableHead>
                    <TableHead>Site</TableHead>
                    <TableHead className="text-right">Times flagged</TableHead>
                    <TableHead>Latest</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {skuRollup.map((s) => (
                    <TableRow key={s.key}>
                      <TableCell className="font-medium">
                        {s.productName ?? "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {s.sku ?? "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {s.siteName ?? "—"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {s.flags}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatDateTime(s.latest)}
                      </TableCell>
                      <TableCell>
                        <Link
                          href={`/inventory/${s.key}`}
                          className="text-sm font-medium hover:underline"
                        >
                          Recount →
                        </Link>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>All flags</CardTitle>
            </CardHeader>
            <CardContent className="px-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product</TableHead>
                    <TableHead>SKU</TableHead>
                    <TableHead>Site</TableHead>
                    <TableHead>Note</TableHead>
                    <TableHead>When</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.ledger_id}>
                      <TableCell className="font-medium">
                        {r.product_name ?? "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        <Link href={`/inventory/${r.child_sku_id}`} className="hover:underline">
                          {r.sku ?? "—"}
                        </Link>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {r.site_name ?? "—"}
                      </TableCell>
                      <TableCell className="max-w-md text-xs text-muted-foreground">
                        {r.note ?? "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatDateTime(r.created_at)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>
      )}
    </>
  )
}
