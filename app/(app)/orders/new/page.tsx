import Link from "next/link"
import { ArrowLeft } from "lucide-react"

import { createClient } from "@/lib/supabase/server"
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

  const [sitesRes, customersRes, skusRes] = await Promise.all([
    supabase.from("sites").select("id, name").eq("is_active", true).order("name"),
    supabase.from("customers").select("id, name").order("name"),
    supabase
      .from("child_skus")
      .select(
        `id, site_id, sku, price,
         product:products(name),
         inventory_levels(available)`,
      )
      .eq("is_active", true),
  ])

  const skus: SkuOption[] = ((skusRes.data ?? []) as unknown as SkuQueryRow[])
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
        customers={customersRes.data ?? []}
        skus={skus}
      />
    </>
  )
}
