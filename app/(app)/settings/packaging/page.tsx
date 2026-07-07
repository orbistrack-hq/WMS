import { createClient } from "@/lib/supabase/server"
import { PageHeader } from "@/components/page-header"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { JAR_MAX_GRAMS } from "@/lib/packing/packaging-rules"
import { PackagingManager, type PackagingType } from "./packaging-manager"
import { PackagingRuleEditor } from "./packaging-rule-editor"
import {
  PackagingStock,
  type StockLevel,
  type StockSite,
  type StockType,
} from "./packaging-stock"

export const dynamic = "force-dynamic"

export default async function PackagingSettingsPage() {
  const supabase = await createClient()

  const [typesRes, sitesRes, levelsRes, adminRes, ruleRes] = await Promise.all([
    supabase
      .from("packaging_types")
      // site_id + the owning site's name so each type can be shown as shared vs
      // owned, and so the client can tell which ones it may manage. RLS already
      // limits this to shared defaults + types at sites the user can access.
      .select("id, name, kind, unit_cost, is_active, site_id, site:sites(name)")
      .order("kind")
      .order("name"),
    supabase.from("sites").select("id, name").eq("is_active", true).order("name"),
    supabase
      .from("packaging_levels")
      .select("packaging_type_id, site_id, on_hand, reorder_point"),
    supabase.rpc("is_admin"),
    supabase.from("packaging_rule").select("jar_max_grams").maybeSingle(),
  ])

  const ruleGrams = Number(ruleRes.data?.jar_max_grams)
  const jarMaxGrams =
    Number.isFinite(ruleGrams) && ruleGrams > 0 ? ruleGrams : JAR_MAX_GRAMS

  const types = (typesRes.data ?? []).map((t) => {
    const site = Array.isArray(t.site) ? t.site[0] : t.site
    return {
      id: t.id,
      name: t.name,
      kind: t.kind,
      unit_cost: Number(t.unit_cost),
      is_active: t.is_active,
      site_id: t.site_id ?? null,
      site_name: (site as { name?: string } | null)?.name ?? null,
    }
  }) as PackagingType[]
  const isAdmin = adminRes.data === true

  // sites is already RLS-scoped to what the user can access; it drives both the
  // stock card and the "which site owns a new type" picker in the manager.
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
            <CardTitle className="text-base">Packaging rule</CardTitle>
            <CardDescription>
              The weight cut-off that decides jar vs. bag when packaging is
              auto-filled at packing. It only pre-fills the numbers — the packer
              always confirms.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <PackagingRuleEditor jarMaxGrams={jarMaxGrams} isAdmin={isAdmin} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Packaging types</CardTitle>
            <CardDescription>
              Each type carries a unit cost that is snapshotted when packing
              records consumption, so later price changes don&apos;t rewrite
              historical packaging-cost reports. Shared defaults apply to every
              site; you can also add types owned by your own site.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <PackagingManager
              types={types}
              isAdmin={isAdmin}
              sites={sites}
            />
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
