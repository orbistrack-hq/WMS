import Link from "next/link"
import {
  Plus,
  FolderTree,
  Boxes,
  CopyCheck,
  Layers,
  Scale,
  TriangleAlert,
  X,
} from "lucide-react"

import { createClient } from "@/lib/supabase/server"
import { PageHeader } from "@/components/page-header"
import { Pagination } from "@/components/pagination"
import {
  DEFAULT_PAGE_SIZE,
  parsePageParam,
  pageRangePlusOne,
} from "@/lib/pagination"
import { buttonVariants } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  buildCategoryTree,
  flattenCategoryTree,
  categoryPathMap,
  indent,
  type CategoryRow,
} from "@/lib/catalog/types"
import {
  isMissingWeight,
  missingWeightParentIds,
} from "@/lib/catalog/missing-weight"
import { CatalogFilters } from "./catalog-filters"

export const dynamic = "force-dynamic"

type SearchParams = {
  q?: string
  category?: string
  active?: string
  page?: string
  missing?: string
}

type ChildRow = {
  site_id: string
  is_active: boolean
  grams_per_unit: number | string | null
  variant_label: string | null
}

type ProductRow = {
  id: string
  name: string
  description: string | null
  category_id: string | null
  is_active: boolean
  child_skus: ChildRow[]
}

export default async function CatalogPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const sp = await searchParams
  const supabase = await createClient()

  const { data: categoryRows } = await supabase
    .from("categories")
    .select("id, name, parent_id")
  const categories = (categoryRows ?? []) as CategoryRow[]

  // How many SKUs still span multiple masters — surfaced as a badge on the
  // Duplicates link so operators know there's cleanup waiting.
  const { count: dupCount } = await supabase
    .from("duplicate_products_report")
    .select("sku", { count: "exact", head: true })

  // Parent products worth warning about missing weights: they have a no-weight
  // active child AND carry ≥2 child SKUs (single-child products often have no
  // weight on purpose). RLS-scoped; drives the count, the "?missing=true"
  // filter, and the per-row badge gate below.
  const missingProductIds = await missingWeightParentIds(supabase)
  const missingIdSet = new Set(missingProductIds)
  const missingCount = missingProductIds.length
  const showingMissing = sp.missing === "true"

  const pathMap = categoryPathMap(categories)
  const categoryOptions = flattenCategoryTree(buildCategoryTree(categories)).map(
    (n) => ({ id: n.id, label: `${indent(n.depth)}${n.name}` }),
  )

  const page = parsePageParam(sp.page)
  const [from, to] = pageRangePlusOne(page)

  let query = supabase
    .from("products")
    .select(
      "id, name, description, category_id, is_active, child_skus(site_id, is_active, grams_per_unit, variant_label)",
      { count: "estimated" },
    )
    .order("name")
    .range(from, to)

  if (sp.active === "true") query = query.eq("is_active", true)
  if (sp.active === "false") query = query.eq("is_active", false)
  if (sp.category === "none") query = query.is("category_id", null)
  else if (sp.category) query = query.eq("category_id", sp.category)
  if (sp.q) query = query.ilike("name", `%${sp.q}%`)
  // Restrict to the affected products when the missing-weights filter is on.
  // An empty `in` list matches nothing, which is exactly right when there are
  // none left to fix.
  if (showingMissing) query = query.in("id", missingProductIds)

  const { data, error, count } = await query
  const fetched = (data ?? []) as unknown as ProductRow[]
  const hasMore = fetched.length > DEFAULT_PAGE_SIZE
  const products = fetched.slice(0, DEFAULT_PAGE_SIZE)

  // Build a catalog URL that keeps the current filters but overrides the given
  // keys — used by the missing-weights banner to toggle its filter on/off.
  // Toggling the filter resets to page 1.
  function catalogHref(overrides: Partial<SearchParams>): string {
    const u = new URLSearchParams()
    if (sp.q) u.set("q", sp.q)
    if (sp.category) u.set("category", sp.category)
    if (sp.active) u.set("active", sp.active)
    for (const [k, v] of Object.entries(overrides)) {
      if (v) u.set(k, v)
      else u.delete(k)
    }
    const qs = u.toString()
    return qs ? `/catalog?${qs}` : "/catalog"
  }

  return (
    <>
      <PageHeader
        title="Catalog"
        description="Master products, their child SKUs per location, and categories."
        action={
          <div className="flex gap-2">
            <Link
              href="/catalog/backfill"
              className={buttonVariants({ variant: "outline" })}
            >
              <Layers data-icon="inline-start" /> Group weights
            </Link>
            <Link
              href="/catalog/duplicates"
              className={buttonVariants({ variant: "outline" })}
            >
              <CopyCheck data-icon="inline-start" /> Duplicates
              {dupCount ? (
                <Badge variant="warning" className="ml-1.5">
                  {dupCount}
                </Badge>
              ) : null}
            </Link>
            <Link
              href="/catalog/categories"
              className={buttonVariants({ variant: "outline" })}
            >
              <FolderTree data-icon="inline-start" /> Categories
            </Link>
            <Link href="/catalog/new" className={buttonVariants()}>
              <Plus data-icon="inline-start" /> New product
            </Link>
          </div>
        }
      />

      <CatalogFilters categories={categoryOptions} />

      {showingMissing ? (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
          <span className="flex items-center gap-2">
            <TriangleAlert className="size-4 shrink-0" />
            Showing products with SKUs that have no weight set. Open each and
            fill in the weight.
          </span>
          <Link
            href={catalogHref({ missing: undefined })}
            className="inline-flex items-center gap-1 font-medium hover:underline"
          >
            <X className="size-3.5" /> Clear
          </Link>
        </div>
      ) : missingCount > 0 ? (
        <Link
          href={catalogHref({ missing: "true" })}
          className="mb-4 flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800 transition-colors hover:bg-amber-100 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300 dark:hover:bg-amber-900"
        >
          <TriangleAlert className="size-4 shrink-0" />
          {missingCount} {missingCount === 1 ? "product has" : "products have"}{" "}
          SKUs with no weight set — review and fill them in
        </Link>
      ) : null}

      {error ? (
        <Card>
          <CardContent className="py-8 text-sm text-destructive">
            Could not load products: {error.message}
          </CardContent>
        </Card>
      ) : products.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <div className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <Boxes className="size-6" />
            </div>
            {showingMissing ? (
              <>
                <p className="text-sm text-muted-foreground">
                  No products with missing weights match these filters. Every
                  SKU here has a weight (or an intentional variant label) set.
                </p>
                <Link
                  href={catalogHref({ missing: undefined })}
                  className={buttonVariants({ variant: "outline" })}
                >
                  <X data-icon="inline-start" /> Clear missing-weights filter
                </Link>
              </>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">
                  No products match these filters.
                </p>
                <Link
                  href="/catalog/new"
                  className={buttonVariants({ variant: "outline" })}
                >
                  <Plus data-icon="inline-start" /> Add the first product
                </Link>
              </>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead>Category</TableHead>
                <TableHead className="text-right">SKUs</TableHead>
                <TableHead className="text-right">Sites</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {products.map((p) => {
                const siteCount = new Set(
                  p.child_skus.map((c) => c.site_id),
                ).size
                const missingWeights = missingIdSet.has(p.id)
                  ? p.child_skus.filter(isMissingWeight).length
                  : 0
                return (
                  <TableRow key={p.id}>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2">
                        <Link
                          href={`/catalog/${p.id}`}
                          className="hover:underline"
                        >
                          {p.name}
                        </Link>
                        {missingWeights > 0 ? (
                          <Badge
                            variant="warning"
                            title="Child SKUs with no weight set"
                          >
                            <Scale />
                            {missingWeights} missing weight
                          </Badge>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {p.category_id ? pathMap.get(p.category_id) ?? "—" : "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {p.child_skus.length}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {siteCount}
                    </TableCell>
                    <TableCell>
                      {p.is_active ? (
                        <Badge variant="success">Active</Badge>
                      ) : (
                        <Badge variant="muted">Inactive</Badge>
                      )}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
          <Pagination
            basePath="/catalog"
            params={sp}
            page={page}
            hasMore={hasMore}
            pageRows={products.length}
            approxTotal={count ?? null}
          />
        </Card>
      )}
    </>
  )
}
