import Link from "next/link"

import { createClient } from "@/lib/supabase/server"
import { PageHeader } from "@/components/page-header"
import { buttonVariants } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { cn } from "@/lib/utils"
import {
  PackagingStock,
  type StockLevel,
  type StockType,
} from "./packaging-stock"

export const dynamic = "force-dynamic"

export default async function PackagingIntakePage() {
  const supabase = await createClient()

  const [typesRes, levelsRes, adminRes, operatorRes] = await Promise.all([
    supabase
      .from("packaging_types")
      .select("id, name, kind, unit_cost")
      .eq("is_active", true)
      .order("kind")
      .order("name"),
    // Central levels: one row per type (no site) since migration 0047.
    supabase
      .from("packaging_levels")
      .select("packaging_type_id, on_hand, reorder_point"),
    supabase.rpc("is_admin"),
    supabase.rpc("is_operator"),
  ])

  const types = (typesRes.data ?? []).map((t) => ({
    id: t.id,
    name: t.name,
    kind: t.kind,
    unit_cost: Number(t.unit_cost),
  })) as StockType[]

  const levels = (levelsRes.data ?? []).map((l) => ({
    packaging_type_id: l.packaging_type_id,
    on_hand: Number(l.on_hand),
    reorder_point: l.reorder_point === null ? null : Number(l.reorder_point),
  })) as StockLevel[]

  // Packaging is a central warehouse resource: only the internal ops team
  // (admin or operator) receives/adjusts it. Everyone else sees the counts.
  const canManage = adminRes.data === true || operatorRes.data === true

  return (
    <>
      <PageHeader
        title="Packaging intake"
        description="Central packaging stock on hand — one pool per type, shared across every site. Receive new stock and record counted corrections here."
      />

      <div className="flex max-w-2xl flex-col gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Stock on hand</CardTitle>
            <CardDescription>
              Boxes, labels, jars, bags, and Mylar. Consumed automatically at
              packing (counted once per combined-order group).
            </CardDescription>
          </CardHeader>
          <CardContent>
            <PackagingStock types={types} levels={levels} canManage={canManage} />
          </CardContent>
        </Card>

        <p className="text-xs text-muted-foreground">
          Need to add, rename, or re-price a packaging type, or edit the
          weight → packaging rules?{" "}
          <Link
            href="/settings/packaging"
            className={cn(
              buttonVariants({ variant: "link", size: "sm" }),
              "h-auto p-0",
            )}
          >
            Manage packaging types in Settings
          </Link>
          .
        </p>
      </div>
    </>
  )
}
