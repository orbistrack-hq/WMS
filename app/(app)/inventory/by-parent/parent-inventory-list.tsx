"use client"

import { useState } from "react"
import Link from "next/link"
import { ChevronDown, ChevronRight, MapPin } from "lucide-react"

import { Badge } from "@/components/ui/badge"
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

export type ParentChild = {
  child_sku_id: string
  site_id: string
  site_name: string
  sku: string | null
  bin_location: string | null
  grams: number | null
  variant_label: string | null
  on_hand: number
  available: number
  reserved: number
  layby: number
  cost: number
  price: number | null
}

export type ParentGroup = {
  product_id: string
  product_name: string
  sites: string[]
  children: ParentChild[]
  totals: {
    on_hand: number
    available: number
    reserved: number
    layby: number
    value: number
  }
  weightCount: number
}

export function ParentInventoryList({
  parents,
  totalCount,
}: {
  parents: ParentGroup[]
  /** Total parents across all pages (defaults to the visible count). */
  totalCount?: number
}) {
  const [open, setOpen] = useState<Set<string>>(new Set())
  const parentTotal = totalCount ?? parents.length

  const allOpen = open.size === parents.length
  function toggle(id: string) {
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  function toggleAll() {
    setOpen(allOpen ? new Set() : new Set(parents.map((p) => p.product_id)))
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between px-1 text-sm text-muted-foreground">
        <span>
          {parentTotal} parent SKU{parentTotal === 1 ? "" : "s"}
        </span>
        <button
          type="button"
          onClick={toggleAll}
          className="font-medium text-foreground hover:underline"
        >
          {allOpen ? "Collapse all" : "Expand all"}
        </button>
      </div>

      {parents.map((p) => {
        const isOpen = open.has(p.product_id)
        return (
          <Card key={p.product_id} className="overflow-hidden p-0">
            <button
              type="button"
              onClick={() => toggle(p.product_id)}
              aria-expanded={isOpen}
              className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/40"
            >
              {isOpen ? (
                <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
              )}
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{p.product_name}</div>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  {p.sites.map((site) => (
                    <Badge key={site} variant="outline" className="gap-1">
                      <MapPin className="size-3 text-muted-foreground" />
                      {site}
                    </Badge>
                  ))}
                  <Badge variant="secondary">
                    {p.weightCount} weight{p.weightCount === 1 ? "" : "s"}
                  </Badge>
                </div>
              </div>
              <dl className="hidden shrink-0 gap-4 text-right text-sm sm:flex">
                <Metric label="On hand" value={p.totals.on_hand} />
                <Metric label="Available" value={p.totals.available} emphasis />
                <Metric label="Reserved" value={p.totals.reserved} />
                <Metric label="Value" text={formatCurrency(p.totals.value)} />
              </dl>
            </button>

            {isOpen ? (
              <div className="border-t bg-muted/20">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Weight</TableHead>
                      <TableHead>Site</TableHead>
                      <TableHead>SKU</TableHead>
                      <TableHead>Bin</TableHead>
                      <TableHead className="text-right">On hand</TableHead>
                      <TableHead className="text-right">Available</TableHead>
                      <TableHead className="text-right">Reserved</TableHead>
                      <TableHead className="text-right">Cost</TableHead>
                      <TableHead className="text-right">Price</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {p.children.map((c, i) => {
                      const prev = p.children[i - 1]
                      const newWeight =
                        !prev || prev.grams !== c.grams
                      return (
                        <TableRow key={c.child_sku_id}>
                          <TableCell>
                            {newWeight ? (
                              <Badge variant="info">
                                {c.variant_label ?? "No weight"}
                              </Badge>
                            ) : (
                              <span className="text-muted-foreground/50">
                                ↳
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {c.site_name}
                          </TableCell>
                          <TableCell>
                            <Link
                              href={`/inventory/${c.child_sku_id}`}
                              className="text-muted-foreground hover:underline"
                            >
                              {c.sku ?? "—"}
                            </Link>
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {c.bin_location ?? "—"}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {c.on_hand}
                          </TableCell>
                          <TableCell className="text-right font-medium tabular-nums">
                            {c.available}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {c.reserved > 0 ? (
                              <Badge variant="info">{c.reserved}</Badge>
                            ) : (
                              <span className="text-muted-foreground">0</span>
                            )}
                          </TableCell>
                          <TableCell className="text-right tabular-nums text-muted-foreground">
                            {formatCurrency(c.cost)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums text-muted-foreground">
                            {c.price == null ? "—" : formatCurrency(c.price)}
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
                <div className="flex justify-end px-4 py-2">
                  <Link
                    href={`/catalog/${p.product_id}`}
                    className="text-xs font-medium text-muted-foreground hover:text-foreground hover:underline"
                  >
                    Edit parent in catalog →
                  </Link>
                </div>
              </div>
            ) : null}
          </Card>
        )
      })}
    </div>
  )
}

function Metric({
  label,
  value,
  text,
  emphasis,
}: {
  label: string
  value?: number
  text?: string
  emphasis?: boolean
}) {
  return (
    <div className="min-w-14">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={`tabular-nums ${emphasis ? "font-semibold" : "font-medium"}`}
      >
        {text ?? value}
      </dd>
    </div>
  )
}
