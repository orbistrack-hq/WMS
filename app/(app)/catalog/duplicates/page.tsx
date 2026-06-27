import Link from "next/link"
import { ArrowLeft, CopyCheck } from "lucide-react"

import { createClient } from "@/lib/supabase/server"
import { Placeholder } from "@/components/page-header"
import { DuplicateGroup, type DupProduct } from "./duplicate-group"

export const dynamic = "force-dynamic"

type ReportRow = { sku: string; parent_count: number; product_ids: string[] }

type ProductRow = {
  id: string
  name: string
  is_active: boolean
  child_skus: { sku: string | null }[] | null
}

export default async function DuplicatesPage() {
  const supabase = await createClient()

  // Each row is a SKU that still spans more than one master product. The view is
  // security_invoker, so an operator only sees duplicates among sites they can
  // access.
  const { data: reportData, error } = await supabase
    .from("duplicate_products_report")
    .select("sku, parent_count, product_ids")
  const report = (reportData ?? []) as ReportRow[]

  // Pull names/SKUs for every product referenced, in one query.
  const ids = [...new Set(report.flatMap((r) => r.product_ids))]
  const infoById = new Map<string, DupProduct>()
  if (ids.length) {
    const { data: products } = await supabase
      .from("products")
      .select("id, name, is_active, child_skus(sku)")
      .in("id", ids)
    for (const p of (products ?? []) as ProductRow[]) {
      const children = p.child_skus ?? []
      infoById.set(p.id, {
        id: p.id,
        name: p.name,
        is_active: p.is_active,
        site_count: children.length,
        skus: children
          .map((c) => c.sku)
          .filter((s): s is string => Boolean(s)),
      })
    }
  }

  // Build groups; keep only those with 2+ resolvable products (actionable).
  const groups = report
    .map((r) => ({
      sku: r.sku,
      products: r.product_ids
        .map((id) => infoById.get(id))
        .filter((p): p is DupProduct => Boolean(p)),
    }))
    .filter((g) => g.products.length > 1)
    .sort((a, b) => a.sku.localeCompare(b.sku))

  return (
    <>
      <Link
        href="/catalog"
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> Catalog
      </Link>
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">Duplicates</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        SKUs that live under more than one master product. Pick which product to
        keep and merge the rest in — their SKUs move across and the emptied
        products are deactivated.
      </p>

      {error ? (
        <Placeholder icon={CopyCheck} title="Couldn't load duplicates">
          {error.message}
        </Placeholder>
      ) : groups.length === 0 ? (
        <Placeholder icon={CopyCheck} title="No duplicates">
          Every SKU maps to a single master product. New duplicates from store
          syncs will show up here.
        </Placeholder>
      ) : (
        <div className="flex max-w-2xl flex-col gap-3">
          {groups.map((g) => (
            <DuplicateGroup key={g.sku} sku={g.sku} products={g.products} />
          ))}
        </div>
      )}
    </>
  )
}
