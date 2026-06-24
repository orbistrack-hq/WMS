import Link from "next/link"
import { Plus, FolderTree, Boxes } from "lucide-react"

import { createClient } from "@/lib/supabase/server"
import { PageHeader } from "@/components/page-header"
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
import { CatalogFilters } from "./catalog-filters"

export const dynamic = "force-dynamic"

type SearchParams = { q?: string; category?: string; active?: string }

type ProductRow = {
  id: string
  name: string
  description: string | null
  category_id: string | null
  is_active: boolean
  child_skus: { site_id: string; is_active: boolean }[]
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
  const pathMap = categoryPathMap(categories)
  const categoryOptions = flattenCategoryTree(buildCategoryTree(categories)).map(
    (n) => ({ id: n.id, label: `${indent(n.depth)}${n.name}` }),
  )

  let query = supabase
    .from("products")
    .select(
      "id, name, description, category_id, is_active, child_skus(site_id, is_active)",
    )
    .order("name")
    .limit(500)

  if (sp.active === "true") query = query.eq("is_active", true)
  if (sp.active === "false") query = query.eq("is_active", false)
  if (sp.category === "none") query = query.is("category_id", null)
  else if (sp.category) query = query.eq("category_id", sp.category)
  if (sp.q) query = query.ilike("name", `%${sp.q}%`)

  const { data, error } = await query
  const products = (data ?? []) as unknown as ProductRow[]

  return (
    <>
      <PageHeader
        title="Catalog"
        description="Master products, their child SKUs per location, and categories."
        action={
          <div className="flex gap-2">
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
            <p className="text-sm text-muted-foreground">
              No products match these filters.
            </p>
            <Link
              href="/catalog/new"
              className={buttonVariants({ variant: "outline" })}
            >
              <Plus data-icon="inline-start" /> Add the first product
            </Link>
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
                return (
                  <TableRow key={p.id}>
                    <TableCell className="font-medium">
                      <Link
                        href={`/catalog/${p.id}`}
                        className="hover:underline"
                      >
                        {p.name}
                      </Link>
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
        </Card>
      )}
    </>
  )
}
