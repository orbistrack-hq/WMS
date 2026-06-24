import Link from "next/link"
import { notFound } from "next/navigation"
import { ArrowLeft } from "lucide-react"

import { createClient } from "@/lib/supabase/server"
import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  buildCategoryTree,
  flattenCategoryTree,
  categoryPathMap,
  indent,
  type CategoryRow,
} from "@/lib/catalog/types"
import { ProductForm } from "../product-form"
import { ChildSkuManager, type ChildSku } from "./child-sku-manager"

export const dynamic = "force-dynamic"

type SkuQueryRow = {
  id: string
  site_id: string
  sku: string | null
  store_variant_id: string | null
  price: number | string
  cost: number | string
  is_active: boolean
  site: { name: string | null } | null
  inventory_levels:
    | { on_hand: number; available: number }
    | { on_hand: number; available: number }[]
    | null
}

type ProductDetail = {
  id: string
  name: string
  description: string | null
  category_id: string | null
  is_active: boolean
  child_skus: SkuQueryRow[]
}

export default async function ProductDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const supabase = await createClient()

  const [productRes, categoryRes, sitesRes] = await Promise.all([
    supabase
      .from("products")
      .select(
        `id, name, description, category_id, is_active,
         child_skus(id, site_id, sku, store_variant_id, price, cost, is_active,
           site:sites(name),
           inventory_levels(on_hand, available))`,
      )
      .eq("id", id)
      .maybeSingle(),
    supabase.from("categories").select("id, name, parent_id"),
    supabase.from("sites").select("id, name").eq("is_active", true).order("name"),
  ])

  if (!productRes.data) notFound()
  const product = productRes.data as unknown as ProductDetail

  const categoryRows = (categoryRes.data ?? []) as CategoryRow[]
  const pathMap = categoryPathMap(categoryRows)
  const categories = flattenCategoryTree(buildCategoryTree(categoryRows)).map(
    (n) => ({ id: n.id, label: `${indent(n.depth)}${n.name}` }),
  )

  const skus: ChildSku[] = (product.child_skus ?? []).map((s) => {
    const inv = Array.isArray(s.inventory_levels)
      ? s.inventory_levels[0]
      : s.inventory_levels
    return {
      id: s.id,
      site_id: s.site_id,
      site_name: s.site?.name ?? "—",
      sku: s.sku,
      store_variant_id: s.store_variant_id,
      price: Number(s.price),
      cost: Number(s.cost),
      is_active: s.is_active,
      on_hand: inv?.on_hand ?? 0,
      available: inv?.available ?? 0,
    }
  })

  const usedSites = new Set(skus.map((s) => s.site_id))
  const availableSites = (sitesRes.data ?? []).filter(
    (s) => !usedSites.has(s.id),
  )

  return (
    <>
      <Link
        href="/catalog"
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> Catalog
      </Link>

      <div className="mb-6 flex items-center gap-2.5">
        <h1 className="text-2xl font-semibold tracking-tight">
          {product.name}
        </h1>
        {product.is_active ? (
          <Badge variant="success">Active</Badge>
        ) : (
          <Badge variant="muted">Inactive</Badge>
        )}
        {product.category_id ? (
          <Badge variant="outline">
            {pathMap.get(product.category_id) ?? "—"}
          </Badge>
        ) : null}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Child SKUs</CardTitle>
            </CardHeader>
            <CardContent>
              <ChildSkuManager
                productId={product.id}
                skus={skus}
                availableSites={availableSites}
              />
            </CardContent>
          </Card>
        </div>

        <div>
          <Card>
            <CardHeader>
              <CardTitle>Product</CardTitle>
            </CardHeader>
            <CardContent>
              <ProductForm
                mode="edit"
                categories={categories}
                product={{
                  id: product.id,
                  name: product.name,
                  description: product.description,
                  category_id: product.category_id,
                  is_active: product.is_active,
                }}
              />
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  )
}
