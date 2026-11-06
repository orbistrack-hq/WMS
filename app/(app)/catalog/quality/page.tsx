import Link from "next/link"

import { createClient } from "@/lib/supabase/server"
import { fetchAllPages } from "@/lib/supabase/fetch-all"
import { PageHeader } from "@/components/page-header"
import { buttonVariants } from "@/components/ui/button"
import type { Quality } from "@/lib/shake"

import { QualityManager, type QualityRow } from "./quality-manager"

export const dynamic = "force-dynamic"

type Raw = {
  id: string
  name: string
  quality: Quality | null
  is_shake: boolean
  child_skus: { grams_per_unit: number | string | null; is_active: boolean; sites: { name: string } | null }[] | null
}

export default async function StrainQualityPage() {
  const supabase = await createClient()
  // Every active product that sells by weight (has a sized child). Paged to
  // exhaustion: PostgREST caps a plain select at 1000 rows without an error.
  const raw = await fetchAllPages<Raw>(() =>
    supabase
      .from("products")
      .select("id, name, quality, is_shake, child_skus(grams_per_unit, is_active, sites(name))")
      .eq("is_active", true)
      .order("name")
      .order("id"),
  )

  const rows: QualityRow[] = raw
    .map((p) => {
      const sized = (p.child_skus ?? []).filter((c) => c.is_active && c.grams_per_unit != null)
      return {
        id: p.id,
        name: p.name,
        quality: p.quality,
        isShake: p.is_shake,
        brands: [...new Set(sized.map((c) => c.sites?.name).filter(Boolean) as string[])].sort(),
        sized: sized.length > 0,
      }
    })
    .filter((r) => r.sized || r.isShake || r.quality)

  return (
    <>
      <PageHeader
        title="Strain quality"
        description="Each strain's quality decides which shake pot its sales count toward. Mark each brand's shake products so the Shake screen can fill them."
        action={
          <Link href="/inventory/shake" className={buttonVariants({ variant: "outline" })}>
            Go to Shake
          </Link>
        }
      />
      <QualityManager rows={rows} />
    </>
  )
}
