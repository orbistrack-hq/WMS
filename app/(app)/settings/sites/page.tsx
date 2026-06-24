import { createClient } from "@/lib/supabase/server"
import { PageHeader } from "@/components/page-header"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { SitesManager, type Site } from "./sites-manager"

export const dynamic = "force-dynamic"

export default async function SitesPage() {
  const supabase = await createClient()

  const [sitesRes, adminRes] = await Promise.all([
    supabase.from("sites").select("id, name, code, is_active").order("name"),
    supabase.rpc("is_admin"),
  ])

  const sites = (sitesRes.data ?? []) as Site[]
  const isAdmin = adminRes.data === true

  return (
    <>
      <PageHeader
        title="Sites"
        description="Warehouses and locations. Inventory, SKUs, and orders are all scoped per site."
      />

      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle className="text-base">Locations</CardTitle>
          <CardDescription>
            Every child SKU, stock level, and order belongs to one site. Add at
            least one before creating products or connecting a store.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SitesManager sites={sites} canManage={isAdmin} />
        </CardContent>
      </Card>
    </>
  )
}
