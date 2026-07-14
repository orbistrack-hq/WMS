"use client"

import { useMemo, useState, useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { ArrowLeft, Check, PackageCheck, Plus, Printer, Trash2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { formatCurrency } from "@/lib/format"

import {
  markGroupPicked,
  packGroup,
  recordPackaging,
  type ActionResult,
} from "../actions"
import type { PackagingTypeOption } from "@/lib/packing/aggregate"
import {
  computeOrderPackaging,
  tallyByWeight,
  type PackagingOrderDefault,
  type PackagingWeightRule,
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
  vacuum_bag: "Vacuum bag",
  mylar_bag: "Mylar bag",
  custom: "Custom",
}

/** One editable packaging line in the wave's inline entry, keyed by type. */
type PackLine = {
  typeId: string
  typeName: string
  kind: string
  unitCost: number
  qty: string
}

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

/**
 * Wave pick runner. Shows the consolidated demand of several groups two ways:
 * "Route" — one bin-sorted pass to gather everything — and "Sort" — the
 * put-wall view that splits the gathered stock back out per order. Sort mode
 * also carries an inline packaging entry per group, auto-seeded from the
 * weight→packaging config (FB-6): each unit maps to its exact-weight packaging
 * (jar / Mylar size), plus one vacuum bag / box / label per order. Confirming a
 * group records that real packaging cost instead of only flipping status — mass
 * packing without leaving the wave. Every seeded line stays editable.
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
  weightRules,
  orderDefaults,
}: {
  siteName: string | null
  groupCount: number
  orderCount: number
  totalUnits: number
  droppedCount: number
  rows: WaveRow[]
  packagingTypes: PackagingTypeOption[]
  existingPackaging: Record<string, number>
  weightRules: PackagingWeightRule[]
  orderDefaults: PackagingOrderDefault[]
}) {
  const [mode, setMode] = useState<Mode>("route")
  const [gathered, setGathered] = useState<Set<string>>(new Set())

  const router = useRouter()
  const [packed, setPacked] = useState<Set<string>>(new Set())
  const [packingId, setPackingId] = useState<string | null>(null)
  const [packError, setPackError] = useState<string | null>(null)
  const [isPacking, startPacking] = useTransition()

  const [addType, setAddType] = useState(packagingTypes[0]?.id ?? "")

  const allGroupIds = useMemo(
    () => [...new Set(rows.flatMap((r) => r.allocations.map((a) => a.groupId)))],
    [rows],
  )

  // Per-group weighted unit lines, so packaging can be seeded from the weight
  // config (FB-6): each row contributes its allocated qty to every group it feeds.
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

  // Seed packaging from the weight→packaging config (FB-6, migration 0046): each
  // unit maps to its exact-weight packaging type (jar / Mylar size), plus the
  // per-order defaults (vacuum bag + box + label) once per group. Lines stay
  // fully editable below. Groups that already have packaging recorded seed 0 so
  // the wave never double-counts.
  const buildDefaultRow = useMemo(() => {
    return (groupId: string): PackLine[] => {
      const hasExisting = (existingPackaging[groupId] ?? 0) > 0
      const computed = computeOrderPackaging(
        unitsByGroup.get(groupId) ?? [],
        weightRules,
        orderDefaults,
      )
      return computed.lines.map((l) => ({
        typeId: l.typeId,
        typeName: l.typeName,
        kind: l.kind,
        unitCost: l.unitCost,
        qty: String(hasExisting ? 0 : l.qty),
      }))
    }
  }, [unitsByGroup, weightRules, orderDefaults, existingPackaging])

  // groupId -> ordered packaging lines (keyed by type). Seeded once from the
  // config; edits persist per group for the rest of this wave session.
  const [packInputs, setPackInputs] = useState<Record<string, PackLine[]>>(() =>
    Object.fromEntries(allGroupIds.map((id) => [id, buildDefaultRow(id)])),
  )

  function setQty(groupId: string, typeId: string, qty: string) {
    setPackInputs((prev) => ({
      ...prev,
      [groupId]: (prev[groupId] ?? []).map((l) =>
        l.typeId === typeId ? { ...l, qty } : l,
      ),
    }))
  }

  function removeLine(groupId: string, typeId: string) {
    setPackInputs((prev) => ({
      ...prev,
      [groupId]: (prev[groupId] ?? []).filter((l) => l.typeId !== typeId),
    }))
  }

  // Add a packaging type to a group's lines (or focus it if already present by
  // seeding qty 1). Keyed by type, so adding an existing type never duplicates.
  function addLine(groupId: string) {
    const t = packagingTypes.find((p) => p.id === addType)
    if (!t) return
    setPackInputs((prev) => {
      const lines = prev[groupId] ?? []
      if (lines.some((l) => l.typeId === t.id)) {
        return {
          ...prev,
          [groupId]: lines.map((l) =>
            l.typeId === t.id
              ? { ...l, qty: String((Number(l.qty) || 0) + 1) }
              : l,
          ),
        }
      }
      return {
        ...prev,
        [groupId]: [
          ...lines,
          {
            typeId: t.id,
            typeName: t.name,
            kind: t.kind,
            unitCost: t.unit_cost,
            qty: "1",
          },
        ],
      }
    })
  }

  // Record every positive-qty packaging line for a group, then flip its
  // status. Packaging writes happen first so a failed write never leaves the
  // group marked packed with missing cost.
  async function packOneGroup(groupId: string): Promise<ActionResult> {
    const lines = packInputs[groupId] ?? []
    for (const { typeId, qty } of lines) {
      const n = Number(qty)
      if (!Number.isFinite(n) || n <= 0) continue
      const res = await recordPackaging(groupId, typeId, n)
      if (!res.ok) return res
    }
    // Sorting the gathered stock back out to each order IS the pick. Record it
    // so pack_group's pick gate passes — otherwise confirming here fails with
    // "Finish picking this group before packing it".
    const picked = await markGroupPicked(groupId)
    if (!picked.ok) return picked
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

  // Weight breakdown across the whole wave (printable): units per weight.
  const weightTally = useMemo(
    () =>
      tallyByWeight(
        rows.map((r) => ({ gramsPerUnit: r.gramsPerUnit, qty: r.qty })),
      ),
    [rows],
  )

  // Packaging the whole wave implies, from the weight→packaging config (FB-6):
  // sum each group's computed packaging (per-order defaults counted once per
  // group). Full quantities — a supply-planning total, independent of what's
  // already recorded on a group's own pack screen.
  const { wavePackaging, waveUnknownUnits } = useMemo(() => {
    const byType = new Map<
      string,
      { typeName: string; kind: string; qty: number }
    >()
    let unknown = 0
    for (const groupId of allGroupIds) {
      const computed = computeOrderPackaging(
        unitsByGroup.get(groupId) ?? [],
        weightRules,
        orderDefaults,
      )
      unknown += computed.unknownWeightUnits
      for (const l of computed.lines) {
        const e = byType.get(l.typeId) ?? {
          typeName: l.typeName,
          kind: l.kind,
          qty: 0,
        }
        e.qty += l.qty
        byType.set(l.typeId, e)
      }
    }
    return {
      wavePackaging: [...byType.values()],
      waveUnknownUnits: unknown,
    }
  }, [allGroupIds, unitsByGroup, weightRules, orderDefaults])

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
            {wavePackaging.length > 0 ? (
              <span className="tabular-nums">
                {wavePackaging
                  .map((p) => `${p.qty} ${p.typeName}`)
                  .join(" · ")}
              </span>
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
            {waveUnknownUnits > 0 ? (
              <span className="ml-1 text-amber-700 dark:text-amber-400">
                · {waveUnknownUnits} unit{waveUnknownUnits === 1 ? "" : "s"} with
                no matching weight rule (add packaging by hand)
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
                    {r.gramsPerUnit == null ? (
                      <Badge variant="warning" className="shrink-0">
                        No weight
                      </Badge>
                    ) : null}
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
                  {(packInputs[o.groupId] ?? []).length > 0 ? (
                    <div className="flex flex-col gap-1.5">
                      {(packInputs[o.groupId] ?? []).map((line) => (
                        <div
                          key={line.typeId}
                          className="flex items-center gap-2"
                        >
                          <span className="flex-1 truncate text-xs">
                            {line.typeName}
                            <span className="ml-1 text-muted-foreground">
                              {PACK_KIND_LABEL[line.kind] ?? line.kind}
                            </span>
                          </span>
                          <Input
                            type="number"
                            min="0"
                            step="1"
                            aria-label={`${line.typeName} quantity`}
                            value={line.qty}
                            onChange={(e) =>
                              setQty(o.groupId, line.typeId, e.target.value)
                            }
                            className="h-8 w-14 text-xs"
                          />
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label={`Remove ${line.typeName}`}
                            onClick={() => removeLine(o.groupId, line.typeId)}
                          >
                            <Trash2 />
                          </Button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      No packaging seeded — add a line below.
                    </p>
                  )}
                  <div className="flex items-end gap-2">
                    <Select
                      className="h-8 flex-1 text-xs"
                      aria-label="Packaging type to add"
                      value={addType}
                      onChange={(e) => setAddType(e.target.value)}
                    >
                      {packagingTypes.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name} ({PACK_KIND_LABEL[t.kind] ?? t.kind})
                        </option>
                      ))}
                    </Select>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => addLine(o.groupId)}
                      disabled={packagingTypes.length === 0}
                    >
                      <Plus data-icon="inline-start" /> Add
                    </Button>
                  </div>
                  <div className="flex justify-between border-t pt-1 text-xs">
                    <span className="text-muted-foreground">Packaging cost</span>
                    <span className="font-medium tabular-nums">
                      {formatCurrency(
                        (packInputs[o.groupId] ?? []).reduce(
                          (s, l) => s + (Number(l.qty) || 0) * l.unitCost,
                          0,
                        ),
                      )}
                    </span>
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
