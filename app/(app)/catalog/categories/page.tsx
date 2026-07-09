import Link from "next/link"
import { ArrowLeft } from "lucide-react"

import { createClient } from "@/lib/supabase/server"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import type { CategoryRow } from "@/lib/catalog/types"
import { CategoryManager } from "./category-manager"

export const dynamic = "force-dynamic"

export default async function CategoriesPage() {
  const supabase = await createClient()

  const [categoryRes, canManageRes] = await Promise.all([
    supabase.from("categories").select("id, name, parent_id"),
    supabase.rpc("can_manage_categories"),
  ])

  const categories = (categoryRes.data ?? []) as CategoryRow[]
  const canManage = canManageRes.data === true

  return (
    <>
      <Link
        href="/catalog"
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> Catalog
      </Link>
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">Categories</h1>

      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle>Category tree</CardTitle>
          <CardDescription>
            Multi-level categories. Move a category by changing its parent;
            a category can&apos;t be nested under itself or its descendants.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CategoryManager categories={categories} canManage={canManage} />
        </CardContent>
      </Card>
    </>
  )
}
