import Link from "next/link"

import { createClient } from "@/lib/supabase/server"
import { PageHeader } from "@/components/page-header"
import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { JAR_MAX_GRAMS } from "@/lib/packing/packaging-rules"
import { PackagingManager, type PackagingType } from "./packaging-manager"
import {
  PackagingThresholds,
  type ThresholdRow,
} from "./packaging-thresholds"
import { PackagingRuleEditor } from "./packaging-rule-editor"
import {
  PackagingRulesMapEditor,
  type OrderDefaultRow,
  type PkgType,
  type WeightRuleRow,
} from "./packaging-rules-map-editor"
import {
  PackagingSkuRulesEditor,
  type SkuRuleRow,
} from "./packaging-sku-rules-editor"

export const dynamic = "force-dynamic"

export default async function PackagingSettingsPage() {
  const supabase = await createClient()

  const [
    typesRes,
    sitesRes,
    adminRes,
    ruleRes,
    operatorRes,
    weightRulesRes,
    orderDefaultsRes,
    skuRulesRes,
    levelsRes,
  ] = await Promise.all([
    supabase
      .from("packaging_types")
      // site_id + the owning site's name so each type can be shown as shared vs
      // owned, and so the client can tell which ones it may manage. RLS already
      // limits this to shared defaults + types at sites the user can access.
      .select("id, name, kind, unit_cost, is_active, site_id, site:sites(name)")
      .order("kind")
      .order("name"),
    supabase.from("sites").select("id, name").eq("is_active", true).order("name"),
    supabase.rpc("is_admin"),
    supabase.from("packaging_rule").select("jar_max_grams").maybeSingle(),
    supabase.rpc("is_operator"),
    supabase
      .from("packaging_weight_rule")
      .select(
        "id, grams_per_unit, qty_per_unit, packaging_type:packaging_types(id, name, kind, unit_cost)",
      )
      .order("grams_per_unit"),
    supabase
      .from("packaging_order_default")
      .select(
        "id, qty, packaging_type:packaging_types(id, name, kind, unit_cost)",
      ),
    // Per-SKU packaging overrides (migration 0080), joined to the child SKU's
    // product + site and the packaging type. RLS scopes child SKUs to sites the
    // caller can see, so a client only sees its own overrides.
    supabase
      .from("packaging_sku_rule")
      .select(
        "id, qty_per_unit, child_sku:child_skus(sku, product:products(name), site:sites(name)), packaging_type:packaging_types(id, name, kind, unit_cost)",
      ),
    // Central on-hand + alert quantity per type (no site) for the alert editor.
    supabase
      .from("packaging_levels")
      .select("packaging_type_id, on_hand, reorder_point"),
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
  // Single Supabase per client: the internal ops team (admin OR operator) manages
  // the shared packaging config, not just admins (FB-7 / migration 0045).
  const canManage = isAdmin || operatorRes.data === true

  // sites is already RLS-scoped to what the user can access; it drives the
  // "which site owns a new type" picker in the manager.
  const sites = (sitesRes.data ?? []) as { id: string; name: string }[]
  const stockTypes = types
    .filter((t) => t.is_active)
    .map((t) => ({
      id: t.id,
      name: t.name,
      kind: t.kind,
      unit_cost: t.unit_cost,
    })) as PkgType[]

  // Alert-quantity editor rows: active types joined to their central level
  // (on_hand + reorder_point). Missing level = never moved, so treat as zero.
  const levelByType = new Map(
    (levelsRes.data ?? []).map((l) => [
      l.packaging_type_id,
      {
        on_hand: Number(l.on_hand),
        reorder_point:
          l.reorder_point === null ? null : Number(l.reorder_point),
      },
    ]),
  )
  const thresholdRows = types
    .filter((t) => t.is_active)
    .map((t) => {
      const lvl = levelByType.get(t.id)
      return {
        id: t.id,
        name: t.name,
        on_hand: lvl?.on_hand ?? 0,
        reorder_point: lvl?.reorder_point ?? null,
      }
    }) as ThresholdRow[]

  // FB-6 weight→packaging map + per-order defaults (migration 0046).
  const oneType = (v: unknown): PkgType | null => {
    const t = (Array.isArray(v) ? v[0] : v) as
      | { id: string; name: string; kind: string; unit_cost: number | string }
      | null
      | undefined
    return t
      ? { id: t.id, name: t.name, kind: t.kind, unit_cost: Number(t.unit_cost) }
      : null
  }
  const weightRules = (weightRulesRes.data ?? []).map((r) => ({
    id: r.id,
    grams_per_unit: Number(r.grams_per_unit),
    qty_per_unit: r.qty_per_unit,
    type: oneType(r.packaging_type),
  })) as WeightRuleRow[]
  const orderDefaults = (orderDefaultsRes.data ?? []).map((d) => ({
    id: d.id,
    qty: d.qty,
    type: oneType(d.packaging_type),
  })) as OrderDefaultRow[]

  // Per-SKU overrides (migration 0080). Flatten the child-SKU embed to sku +
  // product name + site name for a readable, searchable list.
  const oneEmbed = <T,>(v: T | T[] | null | undefined): T | null =>
    (Array.isArray(v) ? (v[0] ?? null) : (v ?? null)) as T | null
  const skuRules = (skuRulesRes.data ?? []).map((r) => {
    const child = oneEmbed(
      r.child_sku as unknown as {
        sku: string | null
        product: { name: string | null } | { name: string | null }[] | null
        site: { name: string | null } | { name: string | null }[] | null
      } | null,
    )
    return {
      id: r.id,
      qty_per_unit: r.qty_per_unit,
      sku: child?.sku ?? null,
      productName: oneEmbed(child?.product)?.name ?? null,
      siteName: oneEmbed(child?.site)?.name ?? null,
      type: oneType(r.packaging_type),
    }
  }) as SkuRuleRow[]

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
            <PackagingRuleEditor jarMaxGrams={jarMaxGrams} canEdit={canManage} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Weight &rarr; packaging
            </CardTitle>
            <CardDescription>
              What packaging each weight uses and what every order gets. The
              packing screen fills this in automatically — different weights can
              use different-sized (differently priced) bags.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <PackagingRulesMapEditor
              weightRules={weightRules}
              orderDefaults={orderDefaults}
              packagingTypes={stockTypes}
              canManage={canManage}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Specific SKU packaging</CardTitle>
            <CardDescription>
              Override the weight rule for individual SKUs. A SKU listed here uses
              the packaging you pick instead of its weight-based packaging — e.g.
              the &ldquo;free eighth&rdquo; products ship in a 7g Mylar bag even
              though they weigh 3.5g. Box, label, and vacuum bag still apply once
              per order. Adding by SKU code covers that SKU across every site.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <PackagingSkuRulesEditor
              rules={skuRules}
              packagingTypes={stockTypes}
              canManage={canManage}
            />
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
              canManageShared={canManage}
              sites={sites}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Low-stock alerts</CardTitle>
            <CardDescription>
              Set the alert quantity for each packaging type. When on-hand stock
              drops to or below it, a red banner appears at the top of the portal
              for everyone until it&apos;s topped up. Managers and admins can edit
              these.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <PackagingThresholds rows={thresholdRows} canManage={canManage} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Stock on hand</CardTitle>
            <CardDescription>
              Packaging stock is now a single central pool per type, shared across
              every site, and lives under Intake so it&apos;s easier to reach while
              receiving. It&apos;s still consumed automatically at packing (counted
              once per combined-order group).
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link
              href="/inventory/packaging"
              className={cn(buttonVariants({ variant: "secondary", size: "sm" }))}
            >
              Go to Intake &rarr; Packaging
            </Link>
          </CardContent>
        </Card>
      </div>
    </>
  )
}
