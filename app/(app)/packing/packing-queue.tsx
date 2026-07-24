"use client"

import { useMemo, useState, useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { EyeOff, Layers, Scale, Search } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Select } from "@/components/ui/select"
import { dismissGroup } from "./actions"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { formatCurrency } from "@/lib/format"

export type QueueGroup = {
  id: string
  siteId: string | null
  customer: string
  site: string
  windowStart: string
  orderNumbers: string[]
  orderCount: number
  itemCount: number
  packagingCost: number
  needsPacking: boolean
  /** A line in the group has a child SKU with no weight — packaging can't auto-fill. */
  needsWeight: boolean
  /** The store already marked an order in this group completed — pack + close it. */
  storeCompleted: boolean
}

type SortKey = "recommended" | "site" | "items" | "orders" | "customer" | "age"

const PAGE_SIZE = 50

const SORTS: Record<SortKey, (a: QueueGroup, b: QueueGroup) => number> = {
  // Needs-packing first, then fewest orders — the original default.
  recommended: (a, b) =>
    a.needsPacking === b.needsPacking
      ? a.orderCount - b.orderCount
      : a.needsPacking
        ? -1
        : 1,
  site: (a, b) => a.site.localeCompare(b.site) || a.customer.localeCompare(b.customer),
  items: (a, b) => b.itemCount - a.itemCount,
  orders: (a, b) => b.orderCount - a.orderCount,
  customer: (a, b) => a.customer.localeCompare(b.customer),
  age: (a, b) => a.windowStart.localeCompare(b.windowStart),
}

/**
 * Packing queue with wave selection. Pickers tick two or more open groups —
 * constrained to a single site, since inventory and the walking route are
 * per-site — and "Pick as wave" hands the set to /packing/wave for one combined,
 * bin-sorted pass. Selection is ephemeral (URL only); no schema yet.
 */
export function PackingQueue({ groups }: { groups: QueueGroup[] }) {
  const router = useRouter()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState("")
  const [siteFilter, setSiteFilter] = useState<string>("")
  const [sort, setSort] = useState<SortKey>("recommended")
  const [groupBySite, setGroupBySite] = useState(false)
  const [page, setPage] = useState(1)

  // Distinct sites present in the queue, for the site filter dropdown.
  const siteOptions = useMemo(() => {
    const m = new Map<string, string>()
    for (const g of groups) if (g.siteId) m.set(g.siteId, g.site)
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]))
  }, [groups])

  // Search + filter, then sort — across the WHOLE queue (the server sends every
  // pre-pack group, not a page), so a search finds an order wherever it sits.
  // Grouping-by-site forces a site-major sort so sections come out contiguous.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const rows = groups.filter((g) => {
      if (siteFilter && g.siteId !== siteFilter) return false
      if (
        q &&
        !g.customer.toLowerCase().includes(q) &&
        !g.orderNumbers.some((n) => n.toLowerCase().includes(q))
      )
        return false
      return true
    })
    rows.sort(SORTS[sort])
    if (groupBySite) {
      rows.sort((a, b) => a.site.localeCompare(b.site) || SORTS[sort](a, b))
    }
    return rows
  }, [groups, siteFilter, query, sort, groupBySite])

  // Paginate the filtered rows for display so a long queue stays manageable,
  // while search/filter still span the whole set above.
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(Math.max(1, page), pageCount)
  const paged = useMemo(
    () => filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [filtered, safePage],
  )

  // Reset to page 1 whenever the filtered set changes shape under the user.
  const resetPage = () => setPage(1)

  // The site a wave is locked to: the site of the first picked group. Until
  // something is selected, every group is selectable.
  const waveSiteId = useMemo(() => {
    for (const g of groups) if (selected.has(g.id)) return g.siteId
    return null
  }, [groups, selected])

  function toggle(g: QueueGroup) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(g.id)) next.delete(g.id)
      else next.add(g.id)
      return next
    })
  }

  // A group is selectable unless a wave is already in progress at another site.
  const lockedOut = (g: QueueGroup) =>
    waveSiteId !== null && !selected.has(g.id) && g.siteId !== waveSiteId

  // Select-all-visible, honouring the single-site wave rule: targets the wave's
  // site if one is set, else the first visible group's site.
  const selectAllTargetSite = waveSiteId ?? paged[0]?.siteId ?? null
  const selectAllEligible = paged.filter(
    (g) => g.siteId === selectAllTargetSite,
  )
  const allVisibleSelected =
    selectAllEligible.length > 0 &&
    selectAllEligible.every((g) => selected.has(g.id))

  function toggleAllVisible() {
    setSelected((prev) => {
      const next = new Set(prev)
      if (allVisibleSelected) {
        for (const g of selectAllEligible) next.delete(g.id)
      } else {
        for (const g of selectAllEligible) next.add(g.id)
      }
      return next
    })
  }

  // Select every group in one site section (sections are single-site already).
  function toggleSection(sectionGroups: QueueGroup[]) {
    const eligible = sectionGroups.filter((g) => !lockedOut(g))
    const allSel = eligible.length > 0 && eligible.every((g) => selected.has(g.id))
    setSelected((prev) => {
      const next = new Set(prev)
      for (const g of eligible) {
        if (allSel) next.delete(g.id)
        else next.add(g.id)
      }
      return next
    })
  }

  const selectedGroups = groups.filter((g) => selected.has(g.id))
  const selectedOrders = selectedGroups.reduce((n, g) => n + g.orderCount, 0)
  const canWave = selectedGroups.length >= 2

  function startWave() {
    if (!canWave) return
    const ids = selectedGroups.map((g) => g.id).join(",")
    router.push(`/packing/wave?groups=${encodeURIComponent(ids)}`)
  }

  // Sections for grouped rendering: contiguous runs of the same site.
  const sections = useMemo(() => {
    if (!groupBySite) return null
    const out: { siteId: string | null; site: string; rows: QueueGroup[] }[] = []
    for (const g of paged) {
      const last = out[out.length - 1]
      if (last && last.siteId === g.siteId) last.rows.push(g)
      else out.push({ siteId: g.siteId, site: g.site, rows: [g] })
    }
    return out
  }, [paged, groupBySite])

  function renderRow(g: QueueGroup) {
    const isSelected = selected.has(g.id)
    const locked = lockedOut(g)
    return (
      <TableRow key={g.id} data-state={isSelected ? "selected" : undefined}>
        <TableCell>
          <input
            type="checkbox"
            className="size-4 cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-40"
            checked={isSelected}
            disabled={locked}
            onChange={() => toggle(g)}
            aria-label={`Add ${g.customer} to wave`}
            title={locked ? "A wave can only span one site" : "Add to wave"}
          />
        </TableCell>
        <TableCell className="font-medium">
          <Link href={`/packing/${g.id}`} className="hover:underline">
            {g.customer}
          </Link>
        </TableCell>
        <TableCell className="text-muted-foreground">{g.site}</TableCell>
        <TableCell className="text-muted-foreground">
          {g.orderNumbers.slice(0, 2).join(", ")}
          {g.orderCount > 2 ? ` +${g.orderCount - 2}` : ""}
        </TableCell>
        <TableCell className="text-right tabular-nums">{g.itemCount}</TableCell>
        <TableCell className="text-right tabular-nums text-muted-foreground">
          {formatCurrency(g.packagingCost)}
        </TableCell>
        <TableCell>
          <div className="flex flex-wrap items-center gap-1">
            {g.needsPacking ? (
              <Badge variant="warning">Needs packing</Badge>
            ) : (
              <Badge variant="success">Packed</Badge>
            )}
            {g.needsWeight ? (
              <Badge
                variant="warning"
                title="A SKU here has no weight set — its jars/bags won't auto-fill. Fix in Catalog."
              >
                <Scale /> Needs weight
              </Badge>
            ) : null}
            {g.storeCompleted ? (
              <Badge
                variant="success"
                title="The store already marked this order completed — pack it and close it out."
              >
                Completed at store
              </Badge>
            ) : null}
          </div>
        </TableCell>
        <TableCell className="text-right">
          <DismissButton group={g} />
        </TableCell>
      </TableRow>
    )
  }

  const headerCheckbox = (
    <input
      type="checkbox"
      className="size-4 cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-40"
      checked={allVisibleSelected}
      disabled={selectAllEligible.length === 0}
      onChange={toggleAllVisible}
      aria-label="Select all visible groups"
      title={
        selectAllTargetSite && siteOptions.length > 1 && !siteFilter
          ? "Selects the visible groups at one site (waves are one site)"
          : "Select all visible groups"
      }
    />
  )

  return (
    <div className="flex flex-col gap-3">
      {/* Organise controls — filter to a site/state, choose a sort, or group
          the queue into per-site sections to wave-pick a whole site at once. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              resetPage()
            }}
            placeholder="Search order # or customer"
            aria-label="Search the packing queue"
            className="h-9 w-60 rounded-md border border-input bg-transparent pl-8 pr-3 text-sm shadow-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </div>

        <Select
          value={siteFilter}
          onChange={(e) => {
            setSiteFilter(e.target.value)
            resetPage()
          }}
          className="w-44"
          aria-label="Filter by site"
        >
          <option value="">All sites</option>
          {siteOptions.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </Select>

        <Select
          value={sort}
          onChange={(e) => {
            setSort(e.target.value as SortKey)
            resetPage()
          }}
          className="w-48"
          aria-label="Sort by"
        >
          <option value="recommended">Sort: Needs packing first</option>
          <option value="site">Sort: Site</option>
          <option value="items">Sort: Most items</option>
          <option value="orders">Sort: Most orders</option>
          <option value="customer">Sort: Customer</option>
          <option value="age">Sort: Oldest first</option>
        </Select>

        <Button
          variant={groupBySite ? "default" : "outline"}
          size="sm"
          onClick={() => setGroupBySite((v) => !v)}
          title="Group the queue into per-site sections"
        >
          <Layers className="size-4" /> Group by site
        </Button>

        <span className="ml-auto text-sm text-muted-foreground tabular-nums">
          {filtered.length} group{filtered.length === 1 ? "" : "s"}
        </span>
      </div>

      {filtered.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted-foreground">
          No groups match these filters.
        </Card>
      ) : sections ? (
        // Grouped: one table per site section, each with a section select-all.
        sections.map((sec) => {
          const eligible = sec.rows.filter((g) => !lockedOut(g))
          const secAllSel =
            eligible.length > 0 && eligible.every((g) => selected.has(g.id))
          return (
            <Card key={sec.siteId ?? "none"} className="p-0">
              <div className="flex items-center gap-2 border-b px-4 py-2.5">
                <input
                  type="checkbox"
                  className="size-4 cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-40"
                  checked={secAllSel}
                  disabled={eligible.length === 0}
                  onChange={() => toggleSection(sec.rows)}
                  aria-label={`Select all groups at ${sec.site}`}
                  title={
                    eligible.length === 0
                      ? "A wave can only span one site"
                      : `Select all groups at ${sec.site}`
                  }
                />
                <span className="text-sm font-medium">{sec.site}</span>
                <Badge variant="secondary">{sec.rows.length}</Badge>
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10" />
                    <TableHead>Customer</TableHead>
                    <TableHead>Site</TableHead>
                    <TableHead>Orders</TableHead>
                    <TableHead className="text-right">Items</TableHead>
                    <TableHead className="text-right">Packaging</TableHead>
                    <TableHead>State</TableHead>
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>{sec.rows.map(renderRow)}</TableBody>
              </Table>
            </Card>
          )
        })
      ) : (
        <Card className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">{headerCheckbox}</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Site</TableHead>
                <TableHead>Orders</TableHead>
                <TableHead className="text-right">Items</TableHead>
                <TableHead className="text-right">Packaging</TableHead>
                <TableHead>State</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>{paged.map(renderRow)}</TableBody>
          </Table>
        </Card>
      )}

      {/* Client-side pagination over the filtered set. Search/filter above still
          span the whole queue, so a match on any page is reachable. */}
      {pageCount > 1 ? (
        <div className="flex items-center justify-end gap-3 text-sm">
          <span className="text-muted-foreground tabular-nums">
            Page {safePage} of {pageCount}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={safePage <= 1}
            onClick={() => setPage(safePage - 1)}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={safePage >= pageCount}
            onClick={() => setPage(safePage + 1)}
          >
            Next
          </Button>
        </div>
      ) : null}

      {/* Wave action bar — appears once anything is selected. */}
      {selectedGroups.length > 0 ? (
        <div className="sticky bottom-4 z-10 flex items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3 shadow-lg">
          <span className="text-sm text-muted-foreground">
            {selectedGroups.length} group{selectedGroups.length === 1 ? "" : "s"} ·{" "}
            {selectedOrders} order{selectedOrders === 1 ? "" : "s"} selected
            {!canWave ? " · pick at least 2 to build a wave" : ""}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
            <Button size="sm" disabled={!canWave} onClick={startWave}>
              <Layers className="size-4" /> Pick as wave
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

/**
 * Per-row "hide" control with a two-step inline confirm. Dismissing is
 * non-destructive (the order/inventory are untouched) and reversible, but it
 * removes the group from the queue, so we confirm before firing. On success the
 * server component refreshes and the row drops out.
 */
function DismissButton({ group }: { group: QueueGroup }) {
  const router = useRouter()
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function run() {
    setError(null)
    startTransition(async () => {
      const res = await dismissGroup(group.id)
      if (!res.ok) {
        setError(res.error)
        setConfirming(false)
        return
      }
      router.refresh()
    })
  }

  if (!confirming) {
    return (
      <div className="flex flex-col items-end gap-1">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setConfirming(true)}
          title="Hide this group from the packing queue"
          aria-label={`Hide ${group.customer} from the queue`}
        >
          <EyeOff className="size-4" /> Hide
        </Button>
        {error ? (
          <p className="text-xs text-destructive">{error}</p>
        ) : null}
      </div>
    )
  }

  return (
    <div className="flex items-center justify-end gap-1">
      <Button variant="destructive" size="sm" onClick={run} disabled={pending}>
        {pending ? "Hiding…" : "Hide"}
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setConfirming(false)}
        disabled={pending}
      >
        Cancel
      </Button>
    </div>
  )
}
