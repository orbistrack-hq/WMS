import { createClient } from "@/lib/supabase/server"
import { PageHeader } from "@/components/page-header"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { PackagingManager, type PackagingType } from "./packaging-manager"
import {
  PackagingStock,
  type StockLevel,
  type StockSite,
  type StockType,
} from "./packaging-stock"

export const dynamic = "force-dynamic"

export default async function PackagingSettingsPage() {
  const supabase = await createClient()

  const [typesRes, sitesRes, levelsRes, adminRes] = await Promise.all([
    supabase
      .from("packaging_types")
      .select("id, name, kind, unit_cost, is_active")
      .order("kind")
      .order("name"),
    supabase.from("sites").select("id, name").eq("is_active", true).order("name"),
    supabase
      .from("packaging_levels")
      .select("packaging_type_id, site_id, on_hand, reorder_point"),
    supabase.rpc("is_admin"),
  ])

  const types = (typesRes.data ?? []).map((t) => ({
    ...t,
    unit_cost: Number(t.unit_cost),
  })) as PackagingType[]
  const isAdmin = adminRes.data === true

  const sites = (sitesRes.data ?? []) as StockSite[]
  const stockTypes = types
    .filter((t) => t.is_active)
    .map((t) => ({
      id: t.id,
      name: t.name,
      kind: t.kind,
      unit_cost: t.unit_cost,
    })) as StockType[]
  const levels = (levelsRes.data ?? []).map((l) => ({
    ...l,
    on_hand: Number(l.on_hand),
    reorder_point: l.reorder_point === null ? null : Number(l.reorder_point),
  })) as StockLevel[]

  return (
    <>
      <PageHeader
        title="Packaging"
        description="Boxes, jars, labels, and bags — their unit costs and per-location stock. Used by the packing screen to record consumption."
      />

      <div className="flex max-w-2xl flex-col gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Packaging types</CardTitle>
            <CardDescription>
              Each type carries a unit cost that is snapshotted when packing
              records consumption, so later price changes don&apos;t rewrite
              historical packaging-cost reports.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <PackagingManager types={types} canManage={isAdmin} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Stock on hand</CardTitle>
            <CardDescription>
              Packaging stock is tracked per location and is consumed
              automatically when an order is packed (counted once per
              combined-order group). Set a low-stock threshold to flag types that
              need reordering.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <PackagingStock sites={sites} types={stockTypes} levels={levels} />
          </CardContent>
        </Card>
      </div>
    </>
  )
}
