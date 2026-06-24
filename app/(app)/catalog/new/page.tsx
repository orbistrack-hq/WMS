import Link from "next/link"
import { ArrowLeft } from "lucide-react"

import { createClient } from "@/lib/supabase/server"
import { Card, CardContent } from "@/components/ui/card"
import {
  buildCategoryTree,
  flattenCategoryTree,
  indent,
  type CategoryRow,
} from "@/lib/catalog/types"
import { ProductForm } from "../product-form"

export const dynamic = "force-dynamic"

export default async function NewProductPage() {
  const supabase = await createClient()
  const { data: categoryRows } = await supabase
    .from("categories")
    .select("id, name, parent_id")
  const categories = flattenCategoryTree(
    buildCategoryTree((categoryRows ?? []) as CategoryRow[]),
  ).map((n) => ({ id: n.id, label: `${indent(n.depth)}${n.name}` }))

  return (
    <>
      <Link
        href="/catalog"
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> Catalog
      </Link>
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">
        New product
      </h1>

      <Card className="max-w-2xl">
        <CardContent>
          <ProductForm mode="create" categories={categories} />
        </CardContent>
      </Card>

      <p className="mt-3 max-w-2xl text-sm text-muted-foreground">
        After creating the product you&apos;ll add its child SKUs — one per
        site, each with its own price, cost, and store variant ID.
      </p>
    </>
  )
}
