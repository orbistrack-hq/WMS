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
import { DeleteProductButton } from "./delete-product-button"
import { MergeProducts } from "./merge-products"

export const dynamic = "force-dynamic"

type SkuQueryRow = {
  id: string
  site_id: string
  sku: string | null
  store_variant_id: string | null
  bin_location: string | null
  barcode: string | null
  grams_per_unit: number | string | null
  variant_label: string | null
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

  const {
    data: { user },
  } = await supabase.auth.getUser()
  const { data: me } = user
    ? await supabase.from("profiles").select("role").eq("id", user.id).maybeSingle()
    : { data: null }
  const isAdmin = (me as { role?: string } | null)?.role === "admin"

  const [productRes, categoryRes, sitesRes] = await Promise.all([
    supabase
      .from("products")
      .select(
        `id, name, description, category_id, is_active,
         child_skus(id, site_id, sku, store_variant_id, bin_location, barcode,
           grams_per_unit, variant_label, price, cost, is_active,
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
      bin_location: s.bin_location,
      barcode: s.barcode,
      grams_per_unit: s.grams_per_unit == null ? null : Number(s.grams_per_unit),
      variant_label: s.variant_label,
      price: Number(s.price),
      cost: Number(s.cost),
      is_active: s.is_active,
      on_hand: inv?.on_hand ?? 0,
      available: inv?.available ?? 0,
    }
  })

  // A product can hold several weight variants per site, so every active site is
  // always available to add another variant to. The DB blocks true duplicates.
  const availableSites = (sitesRes.data ?? []) as { id: string; name: string }[]

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
        {isAdmin ? <DeleteProductButton productId={product.id} /> : null}
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
                isAdmin={isAdmin}
              />
            </CardContent>
          </Card>
        </div>

        <div className="flex flex-col gap-4">
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

          <Card>
            <CardHeader>
              <CardTitle>Duplicates</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="mb-3 text-sm text-muted-foreground">
                Found this product listed twice? Merge the duplicates in — their
                SKUs move here and the emptied products are deactivated.
              </p>
              <MergeProducts
                survivorId={product.id}
                survivorName={product.name}
              />
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  )
}
