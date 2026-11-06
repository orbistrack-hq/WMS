import Link from "next/link"
import { Leaf } from "lucide-react"

import { createClient } from "@/lib/supabase/server"
import { PageHeader } from "@/components/page-header"
import { buttonVariants } from "@/components/ui/button"
import { todayISODate } from "@/lib/format"
import { QUALITIES, type Quality } from "@/lib/shake"

import { ShakeScreen, type DistributionRow, type EntryRow } from "./shake-screen"

export const dynamic = "force-dynamic"

type RawDistribution = {
  id: string
  quality: Quality
  period_from: string
  period_to: string
  total_grams: number | string
  pot_grams: number | string
  note: string | null
  created_at: string
  reversed_at: string | null
  shake_distribution_brands:
    | {
        grams: number | string
        share: number | string
        sold_grams: number | string
        sites: { name: string } | null
      }[]
    | null
}

export default async function ShakePage() {
  const supabase = await createClient()

  const [potsRes, entriesRes, distRes, shakeProductsRes] = await Promise.all([
    supabase.from("shake_pots").select("quality, on_hand_grams"),
    supabase
      .from("shake_ledger")
      .select("id, quality, delta_grams, note, created_at, reversed_at")
      .eq("reason", "shake_in")
      .order("created_at", { ascending: false })
      .limit(25),
    supabase
      .from("shake_distributions")
      .select(
        "id, quality, period_from, period_to, total_grams, pot_grams, note, created_at, reversed_at, shake_distribution_brands(grams, share, sold_grams, sites(name))",
      )
      .order("created_at", { ascending: false })
      .limit(25),
    supabase.from("products").select("quality").eq("is_shake", true).eq("is_active", true),
  ])

  const loadError =
    potsRes.error?.message ??
    entriesRes.error?.message ??
    distRes.error?.message ??
    shakeProductsRes.error?.message ??
    null

  const pots = Object.fromEntries(QUALITIES.map((q) => [q, 0])) as Record<Quality, number>
  for (const p of potsRes.data ?? []) pots[p.quality as Quality] = Number(p.on_hand_grams)

  const hasShakeProduct = Object.fromEntries(QUALITIES.map((q) => [q, false])) as Record<
    Quality,
    boolean
  >
  for (const p of shakeProductsRes.data ?? [])
    if (p.quality) hasShakeProduct[p.quality as Quality] = true

  const lastPeriodTo = Object.fromEntries(QUALITIES.map((q) => [q, null])) as Record<
    Quality,
    string | null
  >
  const distributions: DistributionRow[] = ((distRes.data ?? []) as unknown as RawDistribution[]).map(
    (d) => {
      if (!d.reversed_at) {
        const cur = lastPeriodTo[d.quality]
        if (!cur || d.period_to > cur) lastPeriodTo[d.quality] = d.period_to
      }
      return {
        id: d.id,
        quality: d.quality,
        periodFrom: d.period_from,
        periodTo: d.period_to,
        totalGrams: Number(d.total_grams),
        potGrams: Number(d.pot_grams),
        note: d.note,
        createdAt: d.created_at,
        reversed: d.reversed_at != null,
        brands: (d.shake_distribution_brands ?? [])
          .map((b) => ({
            name: b.sites?.name ?? "—",
            grams: Number(b.grams),
            share: Number(b.share),
            soldGrams: Number(b.sold_grams),
          }))
          .sort((a, b) => b.share - a.share),
      }
    },
  )

  const entries: EntryRow[] = (entriesRes.data ?? []).map((e) => ({
    id: e.id,
    quality: e.quality as Quality,
    grams: Number(e.delta_grams),
    note: e.note,
    createdAt: e.created_at,
    reversed: e.reversed_at != null,
  }))

  return (
    <>
      <PageHeader
        title="Shake"
        description="Weigh shake into the light dep, indoor and exotic pots, then split each pot across brands by what they sold."
        action={
          <Link href="/catalog/quality" className={buttonVariants({ variant: "outline" })}>
            <Leaf data-icon="inline-start" /> Strain quality
          </Link>
        }
      />
      {loadError ? (
        <p className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          Couldn&apos;t load shake data: {loadError}
        </p>
      ) : null}
      <ShakeScreen
        pots={pots}
        hasShakeProduct={hasShakeProduct}
        lastPeriodTo={lastPeriodTo}
        today={todayISODate()}
        entries={entries}
        distributions={distributions}
      />
    </>
  )
}
