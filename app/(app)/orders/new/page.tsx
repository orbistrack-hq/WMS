import Link from "next/link"
import { ArrowLeft } from "lucide-react"

import { createClient } from "@/lib/supabase/server"
import { fetchAllPages } from "@/lib/supabase/fetch-all"
import { OrderForm, type SkuOption } from "./order-form"

export const dynamic = "force-dynamic"

type SkuQueryRow = {
  id: string
  site_id: string
  sku: string | null
  price: number | string
  product: { name: string | null } | null
  inventory_levels: { available: number } | { available: number }[] | null
}

export default async function NewOrderPage() {
  const supabase = await createClient()

  // Both the SKU picker and the customer picker are type-to-filter comboboxes
  // over the FULL list — the client can only match what the server sent. A plain
  // .select() is capped by PostgREST at 1000 rows with no error, so a catalog
  // larger than that lost SKUs from the dropdown at random: a product could show
  // some of its children and silently omit the rest. Page both to exhaustion.
  // See lib/supabase/fetch-all.ts. Ordering is required for the pages to tile:
  // id here (name is not unique — duplicate product names are allowed).
  const [sitesRes, customers, skuRows] = await Promise.all([
    supabase.from("sites").select("id, name").eq("is_active", true).order("name"),
    fetchAllPages<{ id: string; name: string | null }>(() =>
      supabase.from("customers").select("id, name").order("name").order("id"),
    ),
    fetchAllPages<SkuQueryRow>(() =>
      supabase
        .from("child_skus")
        .select(
          `id, site_id, sku, price,
           product:products(name),
           inventory_levels(available)`,
        )
        .eq("is_active", true)
        .order("id"),
    ),
  ])

  const skus: SkuOption[] = skuRows
    .map((s) => {
      const inv = Array.isArray(s.inventory_levels)
        ? s.inventory_levels[0]
        : s.inventory_levels
      return {
        id: s.id,
        site_id: s.site_id,
        product_name: s.product?.name ?? "Unnamed product",
        sku: s.sku,
        price: Number(s.price),
        available: inv?.available ?? 0,
      }
    })
    .sort((a, b) => a.product_name.localeCompare(b.product_name))

  return (
    <>
      <Link
        href="/orders"
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> All orders
      </Link>
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">New order</h1>

      <OrderForm
        sites={sitesRes.data ?? []}
        customers={customers}
        skus={skus}
      />
    </>
  )
}
