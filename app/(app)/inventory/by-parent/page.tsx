import Link from "next/link"
import { Boxes, List } from "lucide-react"

import { createClient } from "@/lib/supabase/server"
import { fetchAllPages } from "@/lib/supabase/fetch-all"
import { PageHeader } from "@/components/page-header"
import { Pagination } from "@/components/pagination"
import { DEFAULT_PAGE_SIZE, parsePageParam } from "@/lib/pagination"
import { buttonVariants } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { InventoryFilters } from "../inventory-filters"
import { ParentInventoryList, type ParentGroup } from "./parent-inventory-list"

export const dynamic = "force-dynamic"

type SearchParams = { q?: string; site?: string; hideZero?: string; page?: string }

type ReportRow = {
  child_sku_id: string
  site_id: string
  site_name: string | null
  product_name: string | null
  sku: string | null
  on_hand: number
  available: number
  reserved: number
  layby: number
  cost: number | string
  value_at_cost: number | string
  product_id: string
  grams_per_unit: number | string | null
  variant_label: string | null
  price: number | string | null
  bin_location: string | null
}

export default async function InventoryByParentPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const sp = await searchParams
  const supabase = await createClient()

  const { data: sites } = await supabase
    .from("sites")
    .select("id, name")
    .order("name")

  // Parent SKU codes (FB-8) live on products, not the inventory_report view, so
  // fetch them separately and join in memory (keeps the view untouched). Also
  // powers searching by parent code below.
  // Paged: this map has to be COMPLETE or search-by-parent-code goes wrong in a
  // way nobody would notice — a truncated map just fails to match, so the parent
  // code you typed looks like it doesn't exist. Ordered by id (unique); sku is
  // nullable and non-unique, so it cannot page.
  const productSkuRows = await fetchAllPages<{ id: string; sku: string | null }>(
    () => supabase.from("products").select("id, sku").order("id"),
  )
  const parentSkuById = new Map<string, string | null>(
    productSkuRows.map((p) => [p.id, p.sku]),
  )

  // Paged, not `.limit(5000)`. supabase/config.toml sets max_rows = 1000, so the
  // old .limit(5000) was silently served 1000 rows with no error — this screen
  // showed the first 1000 child rows and dropped the rest of the catalog.
  // Ordered by child_sku_id (unique, the view's grain); display order is applied
  // in memory below, so DB order only has to be stable for paging.
  const buildQuery = () => {
    let q = supabase
      .from("inventory_report")
      .select(
        `child_sku_id, site_id, site_name, product_name, sku,
         on_hand, available, reserved, layby, cost, value_at_cost,
         product_id, grams_per_unit, variant_label, price, bin_location`,
      )
      .order("child_sku_id")

    if (sp.site) q = q.eq("site_id", sp.site)
    if (sp.hideZero === "1") q = q.gt("on_hand", 0)
    if (sp.q) {
      // Match product name or child SKU (via the view) plus parent SKU code
      // (resolved from the products fetch above, since the view lacks it).
      const needle = sp.q.toLowerCase()
      const filters = [
        `product_name.ilike.%${sp.q}%`,
        `sku.ilike.%${sp.q}%`,
      ]
      const skuMatchIds = [...parentSkuById.entries()]
        .filter(([, sku]) => sku && sku.toLowerCase().includes(needle))
        .map(([id]) => id)
      if (skuMatchIds.length) filters.push(`product_id.in.(${skuMatchIds.join(",")})`)
      q = q.or(filters.join(","))
    }
    return q
  }

  // Probe once so a load failure still renders the error card below.
  const { error } = await buildQuery().range(0, 0)
  const rows = error ? [] : await fetchAllPages<ReportRow>(buildQuery)

  // ---- Group child rows into parents -> weights -> per-site cells ----------
  const parentMap = new Map<string, ParentGroup>()

  for (const r of rows) {
    let g = parentMap.get(r.product_id)
    if (!g) {
      g = {
        product_id: r.product_id,
        product_name: r.product_name ?? "—",
        parent_sku: parentSkuById.get(r.product_id) ?? null,
        sites: [],
        children: [],
        totals: { on_hand: 0, available: 0, reserved: 0, layby: 0, value: 0 },
        weightCount: 0,
      }
      parentMap.set(r.product_id, g)
    }
    const grams =
      r.grams_per_unit == null ? null : Number(r.grams_per_unit)
    g.children.push({
      child_sku_id: r.child_sku_id,
      site_id: r.site_id,
      site_name: r.site_name ?? "—",
      sku: r.sku,
      bin_location: r.bin_location,
      grams,
      variant_label: r.variant_label ?? (grams != null ? `${grams}g` : null),
      on_hand: r.on_hand,
      available: r.available,
      reserved: r.reserved,
      layby: r.layby,
      cost: Number(r.cost),
      price: r.price == null ? null : Number(r.price),
    })
    g.totals.on_hand += r.on_hand
    g.totals.available += r.available
    g.totals.reserved += r.reserved
    g.totals.layby += r.layby
    g.totals.value += Number(r.value_at_cost)
  }

  const parents = [...parentMap.values()].sort((a, b) =>
    a.product_name.localeCompare(b.product_name),
  )
  for (const g of parents) {
    g.sites = [...new Set(g.children.map((c) => c.site_name))].sort()
    g.weightCount = new Set(
      g.children.map((c) => (c.grams == null ? "none" : String(c.grams))),
    ).size
    // weight ascending (null weights last), then site name
    g.children.sort((a, b) => {
      const ag = a.grams ?? Infinity
      const bg = b.grams ?? Infinity
      if (ag !== bg) return ag - bg
      return a.site_name.localeCompare(b.site_name)
    })
  }

  // Paginate at the PARENT level (never split a parent's child rows across
  // pages). Parents are already fully grouped, so the total is exact and each
  // parent's totals stay intact.
  const page = parsePageParam(sp.page)
  const totalParents = parents.length
  const from = (page - 1) * DEFAULT_PAGE_SIZE
  const pageParents = parents.slice(from, from + DEFAULT_PAGE_SIZE)
  const hasMore = from + DEFAULT_PAGE_SIZE < totalParents

  return (
    <>
      <PageHeader
        title="Inventory by parent"
        description="One row per parent SKU — expand to see every site and weight, with all stock and cost info in one place."
        action={
          <Link
            href="/inventory"
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            <List /> Flat list
          </Link>
        }
      />

      <InventoryFilters sites={sites ?? []} />

      {error ? (
        <Card>
          <CardContent className="py-8 text-sm text-destructive">
            Could not load inventory: {error.message}
          </CardContent>
        </Card>
      ) : parents.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <div className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <Boxes className="size-6" />
            </div>
            <p className="text-sm text-muted-foreground">
              No stock rows match these filters.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <ParentInventoryList parents={pageParents} totalCount={totalParents} />
          <Pagination
            basePath="/inventory/by-parent"
            params={sp}
            page={page}
            hasMore={hasMore}
            pageRows={pageParents.length}
            approxTotal={totalParents}
          />
        </>
      )}
    </>
  )
}
