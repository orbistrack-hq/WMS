"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { ArrowLeft, Check, PackageCheck, Printer } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"

export type WaveAlloc = {
  groupId: string
  groupLabel: string
  orderNumber: string
  qty: number
}

export type WaveRow = {
  childSkuId: string | null
  sku: string | null
  bin: string | null
  name: string
  qty: number
  allocations: WaveAlloc[]
}

type Mode = "route" | "sort"

/**
 * Wave pick runner (v1). Shows the consolidated demand of several groups two
 * ways: "Route" — one bin-sorted pass to gather everything — and "Sort" — the
 * put-wall view that splits the gathered stock back out per order.
 *
 * Check-off is intentionally local/ephemeral: a wave isn't persisted yet, so
 * nothing here writes to pick_progress. Persisting wave progress is the v2 step
 * (add pick_progress.wave_id). Each order's own per-group pick screen remains
 * the system of record.
 */
export function WaveView({
  siteName,
  groupCount,
  orderCount,
  totalUnits,
  droppedCount,
  rows,
}: {
  siteName: string | null
  groupCount: number
  orderCount: number
  totalUnits: number
  droppedCount: number
  rows: WaveRow[]
}) {
  const [mode, setMode] = useState<Mode>("route")
  const [gathered, setGathered] = useState<Set<string>>(new Set())

  const keyOf = (r: WaveRow, i: number) => r.childSkuId ?? `row-${i}`

  function toggle(key: string) {
    setGathered((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const doneCount = rows.reduce(
    (n, r, i) => n + (gathered.has(keyOf(r, i)) ? 1 : 0),
    0,
  )
  const pct = rows.length > 0 ? Math.round((doneCount / rows.length) * 100) : 0

  // Put-wall: regroup the same lines by destination order.
  const byOrder = useMemo(() => {
    const map = new Map<
      string,
      { orderNumber: string; groupId: string; groupLabel: string; items: { name: string; sku: string | null; bin: string | null; qty: number }[] }
    >()
    for (const r of rows) {
      for (const a of r.allocations) {
        const entry = map.get(a.orderNumber) ?? {
          orderNumber: a.orderNumber,
          groupId: a.groupId,
          groupLabel: a.groupLabel,
          items: [],
        }
        entry.items.push({ name: r.name, sku: r.sku, bin: r.bin, qty: a.qty })
        map.set(a.orderNumber, entry)
      }
    }
    return [...map.values()].sort((x, y) =>
      x.orderNumber.localeCompare(y.orderNumber),
    )
  }, [rows])

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      <div className="no-print">
        <Link
          href="/packing"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" /> Back to packing
        </Link>
      </div>

      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Wave pick</h1>
          <p className="text-sm text-muted-foreground">
            {siteName ? `${siteName} · ` : ""}
            {groupCount} groups · {orderCount} orders · {rows.length} SKUs ·{" "}
            {totalUnits} units
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="no-print shrink-0"
          onClick={() => window.print()}
        >
          <Printer className="size-4" /> Print
        </Button>
      </div>

      {droppedCount > 0 ? (
        <div className="no-print rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
          {droppedCount} selected group{droppedCount === 1 ? "" : "s"} dropped —
          no longer open for picking.
        </div>
      ) : null}

      {/* Route progress (route mode only) */}
      {mode === "route" ? (
        <div className="no-print flex flex-col gap-1.5">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium">
              {doneCount} / {rows.length} SKUs gathered
            </span>
            <span className="tabular-nums text-muted-foreground">{pct}%</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      ) : null}

      {/* Mode toggle */}
      <div className="no-print inline-flex w-fit rounded-lg border p-0.5 text-sm">
        <button
          className={
            "rounded-md px-3 py-1 font-medium transition-colors " +
            (mode === "route"
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:text-foreground")
          }
          onClick={() => setMode("route")}
        >
          Pick by route
        </button>
        <button
          className={
            "rounded-md px-3 py-1 font-medium transition-colors " +
            (mode === "sort"
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:text-foreground")
          }
          onClick={() => setMode("sort")}
        >
          Sort to orders
        </button>
      </div>

      {/* ROUTE: one bin-sorted pass, tap to mark gathered. */}
      {mode === "route" ? (
        <div className="flex flex-col gap-2">
          {rows.map((r, i) => {
            const key = keyOf(r, i)
            const done = gathered.has(key)
            return (
              <button
                key={key}
                onClick={() => toggle(key)}
                className={
                  "flex items-center gap-3 rounded-lg border p-3 text-left transition-colors " +
                  (done
                    ? "border-emerald-500/50 bg-emerald-500/5"
                    : "border-border hover:bg-muted/50")
                }
              >
                <span
                  className={
                    "flex size-6 shrink-0 items-center justify-center rounded-md border " +
                    (done
                      ? "border-emerald-500 bg-emerald-500 text-white"
                      : "border-muted-foreground/40")
                  }
                >
                  {done ? <Check className="size-4" /> : null}
                </span>
                <div className="flex min-w-0 flex-1 flex-col">
                  <div className="flex items-center gap-1.5">
                    {r.bin ? (
                      <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs tabular-nums">
                        {r.bin}
                      </span>
                    ) : null}
                    <span className="truncate font-medium">{r.name}</span>
                  </div>
                  <span className="truncate text-xs tabular-nums text-muted-foreground">
                    {r.sku ?? "no SKU"}
                  </span>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {r.allocations.map((a, j) => (
                      <span
                        key={j}
                        className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
                        title={a.groupLabel}
                      >
                        {a.orderNumber} ×{a.qty}
                      </span>
                    ))}
                  </div>
                </div>
                <span className="w-12 shrink-0 text-center text-lg font-semibold tabular-nums">
                  {r.qty}
                </span>
              </button>
            )
          })}
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing to pick in this wave.
            </p>
          ) : null}
        </div>
      ) : null}

      {/* SORT: put-wall — what each order gets from the gathered stock. */}
      {mode === "sort" ? (
        <div className="flex flex-col gap-4">
          {byOrder.map((o) => (
            <div key={o.orderNumber} className="rounded-lg border p-3">
              <div className="mb-2 flex items-center gap-2">
                <Badge variant="secondary">{o.orderNumber}</Badge>
                <span className="truncate text-sm text-muted-foreground">
                  {o.groupLabel}
                </span>
                <Link
                  href={`/packing/${o.groupId}`}
                  className="no-print ml-auto inline-flex shrink-0 items-center gap-1 text-sm font-medium text-primary hover:underline"
                >
                  <PackageCheck className="size-4" /> Pack
                </Link>
              </div>
              <ul className="flex flex-col gap-1 text-sm">
                {o.items.map((it, j) => (
                  <li key={j} className="flex items-center gap-2">
                    {it.bin ? (
                      <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs tabular-nums">
                        {it.bin}
                      </span>
                    ) : null}
                    <span className="flex-1 truncate">{it.name}</span>
                    <span className="tabular-nums text-muted-foreground">
                      {it.sku ?? "—"}
                    </span>
                    <span className="w-10 text-right font-semibold tabular-nums">
                      ×{it.qty}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {byOrder.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing to sort in this wave.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
