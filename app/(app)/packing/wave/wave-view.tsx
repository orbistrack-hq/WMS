"use client"

import { useMemo, useState, useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { ArrowLeft, Check, PackageCheck, Printer } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select } from "@/components/ui/select"
import { formatCurrency } from "@/lib/format"

import { packGroup, recordPackaging, type ActionResult } from "../actions"
import type { PackagingTypeOption } from "@/lib/packing/aggregate"
import {
  derivePackagingForGroup,
  tallyByWeight,
  type WeightedUnit,
} from "@/lib/packing/packaging-rules"

/** "3.5g", "28g" — trims trailing zeros from a numeric(8,2) weight. */
function formatGrams(g: number | null): string {
  return g == null ? "No weight" : `${Number(g)}g`
}

const PACK_KIND_LABEL: Record<string, string> = {
  box: "Box",
  shipping_label: "Label",
  jar: "Jar",
  jar_label: "Jar label",
  vacuum_bag: "Bag",
  custom: "Custom",
}

// Kind display order for the inline packaging entry (box/label first).
const KIND_ORDER = [
  "box",
  "shipping_label",
  "jar",
  "jar_label",
  "vacuum_bag",
  "custom",
]

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
  gramsPerUnit: number | null
  allocations: WaveAlloc[]
}

type Mode = "route" | "sort"

type PackField = { typeId: string; qty: string }

/**
 * Wave pick runner. Shows the consolidated demand of several groups two ways:
 * "Route" — one bin-sorted pass to gather everything — and "Sort" — the
 * put-wall view that splits the gathered stock back out per order. Sort mode
 * also carries an inline packaging entry per group (box/label default to 1,
 * jars/bags default to 0) so confirming a group records real packaging cost
 * instead of only flipping status — mass packing without leaving the wave.
 *
 * Check-off is intentionally local/ephemeral: a wave isn't persisted yet, so
 * nothing here writes to pick_progress. Persisting wave progress is a later
 * step (add pick_progress.wave_id). Each order's own per-group pack screen
 * remains the system of record and the place to edit/remove lines afterward.
 */
export function WaveView({
  siteName,
  groupCount,
  orderCount,
  totalUnits,
  droppedCount,
  rows,
  packagingTypes,
  existingPackaging,
  jarMaxGrams,
}: {
  siteName: string | null
  groupCount: number
  orderCount: number
  totalUnits: number
  droppedCount: number
  rows: WaveRow[]
  packagingTypes: PackagingTypeOption[]
  existingPackaging: Record<string, number>
  jarMaxGrams: number
}) {
  const [mode, setMode] = useState<Mode>("route")
  const [gathered, setGathered] = useState<Set<string>>(new Set())

  const router = useRouter()
  const [packed, setPacked] = useState<Set<string>>(new Set())
  const [packingId, setPackingId] = useState<string | null>(null)
  const [packError, setPackError] = useState<string | null>(null)
  const [isPacking, startPacking] = useTransition()

  const typesByKind = useMemo(() => {
    const m = new Map<string, PackagingTypeOption[]>()
    for (const t of packagingTypes) {
      const arr = m.get(t.kind) ?? []
      arr.push(t)
      m.set(t.kind, arr)
    }
    return m
  }, [packagingTypes])

  const allGroupIds = useMemo(
    () => [...new Set(rows.flatMap((r) => r.allocations.map((a) => a.groupId)))],
    [rows],
  )

  // Per-group weighted unit lines, so packaging can be seeded from the weight
  // rule (FB-3): each row contributes its allocated qty to every group it feeds.
  const unitsByGroup = useMemo(() => {
    const m = new Map<string, WeightedUnit[]>()
    for (const r of rows) {
      for (const a of r.allocations) {
        const arr = m.get(a.groupId) ?? []
        arr.push({ gramsPerUnit: r.gramsPerUnit, qty: a.qty })
        m.set(a.groupId, arr)
      }
    }
    return m
  }, [rows])

  // Seed packaging from the weight rule (3.5g → jar + jar label, heavier → bag;
  // 1 box + 1 label per group). Numbers stay fully editable below. Groups that
  // already have packaging recorded seed 0 so the wave never double-counts.
  function buildDefaultRow(groupId: string): Record<string, PackField> {
    const hasExisting = (existingPackaging[groupId] ?? 0) > 0
    const d = derivePackagingForGroup(
      unitsByGroup.get(groupId) ?? [],
      jarMaxGrams,
    )
    const seed: Record<string, number> = {
      box: d.box,
      shipping_label: d.shipping_label,
      jar: d.jar,
      jar_label: d.jar_label,
      vacuum_bag: d.vacuum_bag,
      custom: 0,
    }
    const row: Record<string, PackField> = {}
    for (const kind of KIND_ORDER) {
      const options = typesByKind.get(kind)
      if (!options || options.length === 0) continue
      const qty = hasExisting ? 0 : (seed[kind] ?? 0)
      row[kind] = { typeId: options[0].id, qty: String(qty) }
    }
    return row
  }

  // groupId -> kind -> { typeId, qty }. Seeded once from defaults; edits persist
  // per group for the rest of this wave session.
  const [packInputs, setPackInputs] = useState<
    Record<string, Record<string, PackField>>
  >(() =>
    Object.fromEntries(allGroupIds.map((id) => [id, buildDefaultRow(id)])),
  )

  function setQty(groupId: string, kind: string, qty: string) {
    setPackInputs((prev) => ({
      ...prev,
      [groupId]: {
        ...prev[groupId],
        [kind]: { ...prev[groupId]?.[kind], qty },
      },
    }))
  }

  function setPackType(groupId: string, kind: string, typeId: string) {
    setPackInputs((prev) => ({
      ...prev,
      [groupId]: {
        ...prev[groupId],
        [kind]: { ...prev[groupId]?.[kind], typeId },
      },
    }))
  }

  // Record every positive-qty packaging line for a group, then flip its
  // status. Packaging writes happen first so a failed write never leaves the
  // group marked packed with missing cost.
  async function packOneGroup(groupId: string): Promise<ActionResult> {
    const row = packInputs[groupId] ?? {}
    for (const kind of Object.keys(row)) {
      const { typeId, qty } = row[kind]
      const n = Number(qty)
      if (!Number.isFinite(n) || n <= 0) continue
      const res = await recordPackaging(groupId, typeId, n)
      if (!res.ok) return res
    }
    return packGroup(groupId)
  }

  function confirmPacked(groupId: string) {
    setPackError(null)
    setPackingId(groupId)
    startPacking(async () => {
      const res = await packOneGroup(groupId)
      setPackingId(null)
      if (!res.ok) {
        setPackError(res.error)
        return
      }
      setPacked((prev) => new Set(prev).add(groupId))
    })
  }

  function confirmAllPacked() {
    setPackError(null)
    startPacking(async () => {
      // Derive group ids from the `rows` prop (not the memoized byOrder) so this
      // handler doesn't close over a memoized value.
      const ids = [
        ...new Set(rows.flatMap((r) => r.allocations.map((a) => a.groupId))),
      ].filter((g) => !packed.has(g))
      const next = new Set(packed)
      for (const g of ids) {
        const res = await packOneGroup(g)
        if (!res.ok) {
          setPackError(`Group ${g.slice(0, 8)}: ${res.error}`)
          break
        }
        next.add(g)
      }
      setPacked(next)
      router.refresh()
    })
  }

  // Weight breakdown across the whole wave (printable). Counts units per weight
  // and the packaging those weights imply: jars for 3.5g, bags for anything
  // heavier, plus 1 box + 1 label per group.
  const weightTally = useMemo(
    () =>
      tallyByWeight(
        rows.map((r) => ({ gramsPerUnit: r.gramsPerUnit, qty: r.qty })),
      ),
    [rows],
  )
  const waveJars = weightTally
    .filter((t) => t.grams != null && t.grams <= jarMaxGrams)
    .reduce((n, t) => n + t.units, 0)
  const waveBags = weightTally
    .filter((t) => t.grams != null && t.grams > jarMaxGrams)
    .reduce((n, t) => n + t.units, 0)
  const waveUnknown = weightTally
    .filter((t) => t.grams == null)
    .reduce((n, t) => n + t.units, 0)

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

      {/* Weight breakdown + implied packaging — printed with the wave sheet. */}
      {weightTally.length > 0 ? (
        <div className="rounded-lg border p-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Weight breakdown</h2>
            <span className="text-xs text-muted-foreground">
              {totalUnits} units
            </span>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {weightTally.map((t) => (
              <span
                key={String(t.grams)}
                className="rounded bg-muted px-2 py-0.5 text-sm tabular-nums"
              >
                {formatGrams(t.grams)} × {t.units}
              </span>
            ))}
          </div>
          <div className="mt-3 border-t pt-2 text-sm">
            <span className="text-muted-foreground">Packaging needed: </span>
            <span className="tabular-nums">
              {waveJars} jar{waveJars === 1 ? "" : "s"} · {waveBags} bag
              {waveBags === 1 ? "" : "s"} · {groupCount} box
              {groupCount === 1 ? "" : "es"} · {groupCount} label
              {groupCount === 1 ? "" : "s"}
            </span>
            {waveUnknown > 0 ? (
              <span className="ml-1 text-amber-700 dark:text-amber-400">
                · {waveUnknown} unit{waveUnknown === 1 ? "" : "s"} with no weight
                (add packaging by hand)
              </span>
            ) : null}
          </div>
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
          {byOrder.length > 0 ? (
            <div className="no-print flex items-center justify-between gap-2">
              <p className="text-sm text-muted-foreground">
                Confirm each group as you finish sorting it.
              </p>
              <Button
                size="sm"
                variant="outline"
                disabled={isPacking}
                onClick={confirmAllPacked}
              >
                Confirm all packed
              </Button>
            </div>
          ) : null}
          {packError ? (
            <p className="no-print text-sm whitespace-pre-line text-destructive">
              {packError}
            </p>
          ) : null}
          {byOrder.map((o) => (
            <div key={o.orderNumber} className="rounded-lg border p-3">
              <div className="mb-2 flex items-center gap-2">
                <Badge variant="secondary">{o.orderNumber}</Badge>
                <span className="truncate text-sm text-muted-foreground">
                  {o.groupLabel}
                </span>
                {packed.has(o.groupId) ? (
                  <Badge variant="success" className="no-print ml-auto shrink-0">
                    <Check className="size-3.5" /> Packed
                  </Badge>
                ) : (
                  <div className="no-print ml-auto flex shrink-0 items-center gap-2">
                    <Link
                      href={`/packing/${o.groupId}`}
                      className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
                    >
                      <PackageCheck className="size-4" /> Pack
                    </Link>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={isPacking && packingId === o.groupId}
                      onClick={() => confirmPacked(o.groupId)}
                    >
                      {isPacking && packingId === o.groupId
                        ? "Confirming…"
                        : "Confirm packed"}
                    </Button>
                  </div>
                )}
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

              {!packed.has(o.groupId) ? (
                <div className="no-print mt-2 flex flex-col gap-2 rounded-md border border-dashed border-border p-2">
                  {(existingPackaging[o.groupId] ?? 0) > 0 ? (
                    <p className="text-xs text-muted-foreground">
                      {formatCurrency(existingPackaging[o.groupId])} already
                      recorded for this group —{" "}
                      <Link
                        href={`/packing/${o.groupId}`}
                        className="underline"
                      >
                        edit
                      </Link>
                      . Add more below only if needed.
                    </p>
                  ) : null}
                  <div className="flex flex-wrap items-end gap-2">
                    {Object.entries(packInputs[o.groupId] ?? {}).map(
                      ([kind, field]) => {
                        const options = typesByKind.get(kind) ?? []
                        return (
                          <div key={kind} className="flex flex-col gap-1">
                            <Label className="text-[11px] text-muted-foreground">
                              {PACK_KIND_LABEL[kind] ?? kind}
                            </Label>
                            <div className="flex items-center gap-1">
                              {options.length > 1 ? (
                                <Select
                                  className="h-8 w-28 text-xs"
                                  value={field.typeId}
                                  onChange={(e) =>
                                    setPackType(
                                      o.groupId,
                                      kind,
                                      e.target.value,
                                    )
                                  }
                                >
                                  {options.map((t) => (
                                    <option key={t.id} value={t.id}>
                                      {t.name}
                                    </option>
                                  ))}
                                </Select>
                              ) : null}
                              <Input
                                type="number"
                                min="0"
                                step="1"
                                value={field.qty}
                                onChange={(e) =>
                                  setQty(o.groupId, kind, e.target.value)
                                }
                                className="h-8 w-14 text-xs"
                              />
                            </div>
                          </div>
                        )
                      },
                    )}
                  </div>
                </div>
              ) : null}
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
