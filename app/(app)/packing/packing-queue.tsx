"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Layers } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
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
  orderNumbers: string[]
  orderCount: number
  itemCount: number
  packagingCost: number
  needsPacking: boolean
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

  const selectedGroups = groups.filter((g) => selected.has(g.id))
  const selectedOrders = selectedGroups.reduce((n, g) => n + g.orderCount, 0)
  const canWave = selectedGroups.length >= 2

  function startWave() {
    if (!canWave) return
    const ids = selectedGroups.map((g) => g.id).join(",")
    router.push(`/packing/wave?groups=${encodeURIComponent(ids)}`)
  }

  return (
    <div className="flex flex-col gap-3">
      <Card className="p-0">
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
            </TableRow>
          </TableHeader>
          <TableBody>
            {groups.map((g) => {
              const isSelected = selected.has(g.id)
              // Lock the wave to one site: disable other-site groups once a
              // wave is in progress.
              const lockedOut =
                waveSiteId !== null && !isSelected && g.siteId !== waveSiteId
              return (
                <TableRow key={g.id} data-state={isSelected ? "selected" : undefined}>
                  <TableCell>
                    <input
                      type="checkbox"
                      className="size-4 cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-40"
                      checked={isSelected}
                      disabled={lockedOut}
                      onChange={() => toggle(g)}
                      aria-label={`Add ${g.customer} to wave`}
                      title={
                        lockedOut
                          ? "A wave can only span one site"
                          : "Add to wave"
                      }
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
                  <TableCell className="text-right tabular-nums">
                    {g.itemCount}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {formatCurrency(g.packagingCost)}
                  </TableCell>
                  <TableCell>
                    {g.needsPacking ? (
                      <Badge variant="warning">Needs packing</Badge>
                    ) : (
                      <Badge variant="success">Packed</Badge>
                    )}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </Card>

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
