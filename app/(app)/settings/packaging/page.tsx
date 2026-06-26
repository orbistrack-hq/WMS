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

export const dynamic = "force-dynamic"

export default async function PackagingSettingsPage() {
  const supabase = await createClient()

  const [typesRes, adminRes] = await Promise.all([
    supabase
      .from("packaging_types")
      .select("id, name, kind, unit_cost, is_active")
      .order("kind")
      .order("name"),
    supabase.rpc("is_admin"),
  ])

  const types = (typesRes.data ?? []).map((t) => ({
    ...t,
    unit_cost: Number(t.unit_cost),
  })) as PackagingType[]
  const isAdmin = adminRes.data === true

  return (
    <>
      <PageHeader
        title="Packaging"
        description="Boxes, jars, labels, and bags — and their unit costs. Used by the packing screen to record consumption."
      />

      <Card className="max-w-2xl">
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
    </>
  )
}
