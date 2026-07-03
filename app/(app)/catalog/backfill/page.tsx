import Link from "next/link"
import { ArrowLeft } from "lucide-react"

import { scanWeightBackfill } from "./actions"
import { BackfillReview } from "./backfill-review"

export const dynamic = "force-dynamic"

export default async function WeightBackfillPage() {
  const res = await scanWeightBackfill()

  return (
    <>
      <Link
        href="/catalog"
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> Catalog
      </Link>

      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">
          Group weight variants
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Products that were split by weight (e.g. &ldquo;Apple Fritter -
          3.5g&rdquo;) can be consolidated into one strain with weight-variant
          child SKUs, so intake and allocation can use them. Review the proposed
          groups and confirm.
        </p>
      </div>

      {res.ok ? (
        <BackfillReview groups={res.groups} />
      ) : (
        <p className="text-sm text-destructive">{res.error}</p>
      )}
    </>
  )
}
