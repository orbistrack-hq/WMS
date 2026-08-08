import Link from "next/link"

import { createClient } from "@/lib/supabase/server"
import { fetchAllPages } from "@/lib/supabase/fetch-all"

import { IntakeFlow } from "./intake-flow"

export const dynamic = "force-dynamic"

type RawProduct = {
  id: string
  name: string
  sku: string | null
  child_skus: { site_id: string }[] | null
}

export default async function IntakePage({
  searchParams,
}: {
  // FB-5: ?allocate=<productId> lands straight on the allocate step for a product
  // that already has central stock (from the "Awaiting allocation" list or a
  // skip-to-allocate link).
  searchParams: Promise<{ allocate?: string }>
}) {
  const sp = await searchParams
  const supabase = await createClient()
  // The product picker searches the FULL list client-side, so a plain .select()
  // is a trap: PostgREST caps it at 1000 rows with no error and the missing
  // products simply cannot be found. Page to exhaustion. Ordering by (name, id)
  // keeps the display order AND gives the unique tiebreak paging needs —
  // duplicate product names are allowed, so name alone cannot page.
  const [products0, sitesRes, pool] = await Promise.all([
    fetchAllPages<RawProduct>(() =>
      supabase
        .from("products")
        .select("id, name, sku, child_skus(site_id)")
        .eq("is_active", true)
        .order("name")
        .order("id"),
    ),
    supabase
      .from("sites")
      .select("id, name")
      .eq("is_active", true)
      .order("name"),
    // Central (undelegated) grams on hand per parent SKU — powers the
    // "already in central inventory · Allocate now" hint on the select step.
    // Paged for the same reason: a truncated map reads as centralGrams 0, which
    // hides the "Allocate now" hint on stock that is actually sitting there.
    fetchAllPages<{ product_id: string; on_hand_grams: number | string }>(() =>
      supabase
        .from("parent_inventory")
        .select("product_id, on_hand_grams")
        .order("product_id"),
    ),
  ])

  const sites = (sitesRes.data ?? []) as { id: string; name: string }[]
  const siteNameById = new Map(sites.map((s) => [s.id, s.name]))

  const centralById = new Map(
    pool.map((r) => [r.product_id, Number(r.on_hand_grams) || 0]),
  )

  // Which site(s) each parent actually has children in — so a parent with a
  // duplicate name can be told apart by site when selecting it.
  const products = products0.map((p) => ({
    id: p.id,
    name: p.name,
    sku: p.sku,
    centralGrams: centralById.get(p.id) ?? 0,
    sites: [
      ...new Set(
        (p.child_skus ?? [])
          .map((c) => siteNameById.get(c.site_id))
          .filter((n): n is string => Boolean(n)),
      ),
    ].sort(),
  }))

  // Only honor ?allocate= for a product that actually exists in the list.
  const initialAllocateProductId =
    sp.allocate && products.some((p) => p.id === sp.allocate)
      ? sp.allocate
      : null

  return (
    <>
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Intake Inventory
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Receive bulk into a parent SKU, then allocate it to each
            client&apos;s child SKUs. Allocated stock syncs to each store
            automatically.
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1 text-sm font-medium">
          <Link
            href="/inventory/intake/awaiting"
            className="text-primary hover:underline"
          >
            Awaiting allocation
          </Link>
          <Link
            href="/inventory/intake/receipts"
            className="text-primary hover:underline"
          >
            Intake receipts
          </Link>
          <Link
            href="/inventory/intake/history"
            className="text-primary hover:underline"
          >
            Allocation history
          </Link>
        </div>
      </div>
      <IntakeFlow
        products={products}
        initialAllocateProductId={initialAllocateProductId}
      />
    </>
  )
}
