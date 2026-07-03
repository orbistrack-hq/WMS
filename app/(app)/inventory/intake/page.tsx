import Link from "next/link"

import { createClient } from "@/lib/supabase/server"

import { IntakeFlow } from "./intake-flow"

export const dynamic = "force-dynamic"

export default async function IntakePage() {
  const supabase = await createClient()
  const [productsRes, sitesRes] = await Promise.all([
    supabase
      .from("products")
      .select("id, name, child_skus(site_id)")
      .eq("is_active", true)
      .order("name"),
    supabase
      .from("sites")
      .select("id, name")
      .eq("is_active", true)
      .order("name"),
  ])

  const sites = (sitesRes.data ?? []) as { id: string; name: string }[]
  const siteNameById = new Map(sites.map((s) => [s.id, s.name]))

  // Which site(s) each parent actually has children in — so a parent with a
  // duplicate name can be told apart by site when selecting it.
  const rawProducts = (productsRes.data ?? []) as unknown as {
    id: string
    name: string
    child_skus: { site_id: string }[] | null
  }[]
  const products = rawProducts.map((p) => ({
    id: p.id,
    name: p.name,
    sites: [
      ...new Set(
        (p.child_skus ?? [])
          .map((c) => siteNameById.get(c.site_id))
          .filter((n): n is string => Boolean(n)),
      ),
    ].sort(),
  }))

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
        <Link
          href="/inventory/intake/history"
          className="shrink-0 text-sm font-medium text-primary hover:underline"
        >
          Allocation history
        </Link>
      </div>
      <IntakeFlow products={products} sites={sites} />
    </>
  )
}
