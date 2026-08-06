"use client"

import { useEffect, useState, useTransition } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"

import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Button } from "@/components/ui/button"

type SiteOption = { id: string; name: string }

/**
 * Billing period picker. Deliberately narrower than ReportsFilters: a billing
 * run is defined by a date range and (optionally) one brand, so there is no
 * channel or trend-grain control here — one site is one brand, and mixing
 * channels inside a brand's invoice would be wrong.
 *
 * The quick presets write both dates at once so a month is picked without two
 * round-trips, and so the boundary dates are always the real first/last day of
 * the month rather than whatever the user typed.
 */
export function BillingFilters({ sites }: { sites: SiteOption[] }) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const [isPending, startTransition] = useTransition()

  const from = params.get("from") ?? ""
  const to = params.get("to") ?? ""
  const site = params.get("site") ?? ""
  const hasFilters = Boolean(from || to || site)

  // Dates are held locally and only committed on Apply.
  //
  // Navigating on each change meant picking a start date immediately reloaded
  // the whole report against a half-set range — a wasted query, a flash of wrong
  // numbers, and on a big period a real wait before the end date could even be
  // entered. A date range is one decision made across two inputs, so it commits
  // as one.
  const [draftFrom, setDraftFrom] = useState(from)
  const [draftTo, setDraftTo] = useState(to)

  // Resync when the URL changes from anywhere else (preset buttons, Clear, back
  // button) so the inputs never disagree with the report being shown.
  useEffect(() => {
    setDraftFrom(from)
    setDraftTo(to)
  }, [from, to])

  const dirty = draftFrom !== from || draftTo !== to
  const invalid = Boolean(draftFrom && draftTo && draftFrom > draftTo)

  function applyDates() {
    if (invalid) return
    const next = new URLSearchParams(params.toString())
    if (draftFrom) next.set("from", draftFrom)
    else next.delete("from")
    if (draftTo) next.set("to", draftTo)
    else next.delete("to")
    push(next)
  }

  function push(next: URLSearchParams) {
    startTransition(() =>
      router.replace(next.toString() ? `${pathname}?${next.toString()}` : pathname),
    )
  }

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(params.toString())
    if (value) next.set(key, value)
    else next.delete(key)
    push(next)
  }

  // Month presets are built from local calendar parts, not from an ISO string,
  // so the browser's zone can't roll the first of the month back a day.
  function setMonth(offset: number) {
    const now = new Date()
    const start = new Date(now.getFullYear(), now.getMonth() + offset, 1)
    const end = new Date(now.getFullYear(), now.getMonth() + offset + 1, 0)
    const iso = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
        d.getDate(),
      ).padStart(2, "0")}`
    const next = new URLSearchParams(params.toString())
    next.set("from", iso(start))
    next.set("to", iso(end))
    push(next)
  }

  return (
    <div
      className="mb-4 flex flex-wrap items-end gap-3"
      data-pending={isPending ? "" : undefined}
    >
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Period start
        <Input
          type="date"
          value={draftFrom}
          onChange={(e) => setDraftFrom(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && applyDates()}
          className="w-40"
          aria-label="Billing period start"
        />
      </label>

      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Period end
        <Input
          type="date"
          value={draftTo}
          onChange={(e) => setDraftTo(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && applyDates()}
          className="w-40"
          aria-label="Billing period end"
        />
      </label>

      <Button size="sm" onClick={applyDates} disabled={!dirty || invalid || isPending}>
        {isPending ? "Loading…" : "Apply"}
      </Button>

      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Brand
        <Select
          value={site}
          onChange={(e) => setParam("site", e.target.value)}
          className="w-44"
          aria-label="Filter by brand"
        >
          <option value="">All brands</option>
          {sites.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
      </label>

      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={() => setMonth(-1)}>
          Last month
        </Button>
        <Button variant="outline" size="sm" onClick={() => setMonth(0)}>
          This month
        </Button>
      </div>

      {hasFilters ? (
        <Button variant="ghost" size="sm" onClick={() => push(new URLSearchParams())}>
          Clear
        </Button>
      ) : null}

      {invalid ? (
        <span className="self-center text-xs text-destructive">
          Start date is after the end date.
        </span>
      ) : dirty ? (
        <span className="self-center text-xs text-muted-foreground">
          Press Apply to load this period.
        </span>
      ) : null}
    </div>
  )
}
