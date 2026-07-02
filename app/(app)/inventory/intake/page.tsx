import { createClient } from "@/lib/supabase/server"

import { IntakeFlow } from "./intake-flow"

export const dynamic = "force-dynamic"

export default async function IntakePage() {
  const supabase = await createClient()
  const [productsRes, sitesRes] = await Promise.all([
    supabase
      .from("products")
      .select("id, name")
      .eq("is_active", true)
      .order("name"),
    supabase
      .from("sites")
      .select("id, name")
      .eq("is_active", true)
      .order("name"),
  ])

  const products = (productsRes.data ?? []) as { id: string; name: string }[]
  const sites = (sitesRes.data ?? []) as { id: string; name: string }[]

  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">
          Intake Inventory
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Receive bulk into a parent SKU, then allocate it to each client&apos;s
          child SKUs. Allocated stock syncs to each store automatically.
        </p>
      </div>
      <IntakeFlow products={products} sites={sites} />
    </>
  )
}
