"use client"

import { useMemo, useState, useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { AlertCircle, Check, Sparkles, Undo2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select } from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { cn } from "@/lib/utils"
import { weightLabel } from "@/lib/catalog/weight"
import {
  PERIOD_PRESET_LABEL,
  QUALITIES,
  QUALITY_LABEL,
  WEIGH_UNITS,
  gramsUsed,
  gramsWithPounds,
  presetPeriod,
  suggestFill,
  toGrams,
  type PeriodPreset,
  type Quality,
  type WeighUnit,
} from "@/lib/shake"

import {
  distributeShake,
  loadPreview,
  recordShake,
  undoDistribution,
  undoShakeEntry,
  type Preview,
} from "./actions"

export type EntryRow = {
  id: string
  quality: Quality
  grams: number
  note: string | null
  createdAt: string
  reversed: boolean
}

export type DistributionRow = {
  id: string
  quality: Quality
  periodFrom: string
  periodTo: string
  totalGrams: number
  potGrams: number
  note: string | null
  createdAt: string
  reversed: boolean
  brands: { name: string; grams: number; share: number; soldGrams: number }[]
}

const dateTime = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "America/Los_Angeles",
})
const shortDate = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
})
const fmtDay = (iso: string) => shortDate.format(new Date(`${iso}T00:00:00Z`))
const fmtPct = (share: number) => `${(share * 100).toFixed(1)}%`

export function ShakeScreen({
  pots,
  hasShakeProduct,
  lastPeriodTo,
  today,
  entries,
  distributions,
}: {
  pots: Record<Quality, number>
  hasShakeProduct: Record<Quality, boolean>
  lastPeriodTo: Record<Quality, string | null>
  today: string
  entries: EntryRow[]
  distributions: DistributionRow[]
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // ---- Add shake ----
  const [inQuality, setInQuality] = useState<Quality | "">("")
  const [inAmount, setInAmount] = useState("")
  const [inUnit, setInUnit] = useState<WeighUnit>("g")
  const [inNote, setInNote] = useState("")
  const [inRef, setInRef] = useState(() => crypto.randomUUID())
  const inGrams = toGrams(Math.max(0, parseFloat(inAmount) || 0), inUnit)

  // ---- Split ----
  const [quality, setQuality] = useState<Quality>("exotic")
  const [preset, setPreset] = useState<PeriodPreset | "custom">("since_last")
  const initial = presetPeriod("since_last", today, lastPeriodTo.exotic)
  const [from, setFrom] = useState(initial.from)
  const [to, setTo] = useState(initial.to)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [units, setUnits] = useState<Record<string, string>>({})
  const [idemKey, setIdemKey] = useState("")
  const [splitNote, setSplitNote] = useState("")

  function applyPreset(p: PeriodPreset, q: Quality = quality) {
    const r = presetPeriod(p, today, lastPeriodTo[q])
    setPreset(p)
    setFrom(r.from)
    setTo(r.to)
    setPreview(null)
    return r
  }

  function changeQuality(q: Quality) {
    setQuality(q)
    if (preset !== "custom") applyPreset(preset, q)
    else setPreview(null)
  }

  function calculate(q: Quality = quality, f: string = from, t: string = to) {
    setError(null)
    setNotice(null)
    startTransition(async () => {
      const res = await loadPreview({ quality: q, from: f, to: t })
      if (!res.ok) return setError(res.error)
      setPreview(res.preview)
      setUnits({})
      setIdemKey(crypto.randomUUID())
    })
  }

  function addShake() {
    setError(null)
    setNotice(null)
    if (!inQuality) return setError("Pick the shake's quality.")
    if (!(inGrams > 0)) return setError("Enter how much shake you weighed.")
    const q = inQuality
    startTransition(async () => {
      const res = await recordShake({ quality: q, grams: inGrams, ref: inRef, note: inNote })
      if (!res.ok) return setError(res.error)
      setNotice(
        `Added ${gramsWithPounds(inGrams)} to ${QUALITY_LABEL[q]}. The pot now has ${gramsWithPounds(res.potGrams)}.`,
      )
      setInAmount("")
      setInNote("")
      setInRef(crypto.randomUUID())
      // Line the split up on the pot that just grew.
      setQuality(q)
      const r = presetPeriod(preset === "custom" ? "since_last" : preset, today, lastPeriodTo[q])
      if (preset === "custom") setPreset("since_last")
      setFrom(r.from)
      setTo(r.to)
      setPreview(null)
      router.refresh()
    })
  }

  // Per-brand usage of the entered units.
  const usage = useMemo(() => {
    const out: Record<string, number> = {}
    for (const b of preview?.brands ?? []) {
      const u: Record<string, number> = {}
      for (const v of b.variants) u[v.child_sku_id] = parseInt(units[v.child_sku_id] || "0", 10) || 0
      out[b.site_id] = gramsUsed(
        u,
        b.variants.map((v) => ({ id: v.child_sku_id, gramsPerUnit: v.grams_per_unit })),
      )
    }
    return out
  }, [preview, units])
  const totalUsed = Object.values(usage).reduce((a, b) => a + b, 0)
  const overBrands = (preview?.brands ?? []).filter((b) => usage[b.site_id] > b.target_grams + 1e-9)
  const canSplit =
    !!preview &&
    preview.total_sold_grams > 0 &&
    totalUsed > 0 &&
    overBrands.length === 0 &&
    totalUsed <= preview.pot_grams + 1e-9

  function suggest(siteId?: string) {
    if (!preview) return
    setUnits((prev) => {
      const next = { ...prev }
      for (const b of preview.brands) {
        if (siteId && b.site_id !== siteId) continue
        const fill = suggestFill(
          b.target_grams,
          b.variants.map((v) => ({ id: v.child_sku_id, gramsPerUnit: v.grams_per_unit })),
        )
        for (const v of b.variants) next[v.child_sku_id] = fill[v.child_sku_id] ? String(fill[v.child_sku_id]) : ""
      }
      return next
    })
  }

  function split() {
    if (!preview || !canSplit) return
    setError(null)
    setNotice(null)
    const lines = Object.entries(units)
      .map(([child_sku_id, u]) => ({ child_sku_id, units: parseInt(u || "0", 10) || 0 }))
      .filter((l) => l.units > 0)
    startTransition(async () => {
      const res = await distributeShake({
        quality: preview.quality,
        from: preview.period_from,
        to: preview.period_to,
        lines,
        idempotencyKey: idemKey,
        note: splitNote,
      })
      if (!res.ok) return setError(res.error)
      setNotice(
        `Split ${gramsWithPounds(res.totalGrams)} of ${QUALITY_LABEL[preview.quality]} shake and added the units to stock. ${gramsWithPounds(res.potGrams)} stays in the pot.`,
      )
      const r = presetPeriod(preset === "custom" ? "since_last" : preset, today, preview.period_to)
      if (preset === "custom") setPreset("since_last")
      setFrom(r.from)
      setTo(r.to)
      setPreview(null)
      setUnits({})
      setSplitNote("")
      router.refresh()
    })
  }

  function undo(kind: "distribution" | "entry", id: string, what: string) {
    if (!window.confirm(`Undo ${what}?`)) return
    setError(null)
    setNotice(null)
    startTransition(async () => {
      const res = kind === "distribution" ? await undoDistribution(id) : await undoShakeEntry(id)
      if (!res.ok) return setError(res.error)
      setNotice(`Undid ${what}.`)
      setPreview(null)
      router.refresh()
    })
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Pots */}
      <div className="grid gap-3 sm:grid-cols-3">
        {QUALITIES.map((q) => (
          <Card key={q} size="sm">
            <CardContent className="flex flex-col gap-1">
              <span className="text-sm text-muted-foreground">{QUALITY_LABEL[q]} pot</span>
              <span className="text-2xl font-semibold tabular-nums">{gramsWithPounds(pots[q])}</span>
              {!hasShakeProduct[q] ? (
                <span className="text-xs text-amber-700 dark:text-amber-400">
                  No brand has {withArticle(QUALITY_LABEL[q].toLowerCase())} shake product yet
                </span>
              ) : null}
            </CardContent>
          </Card>
        ))}
      </div>

      {error ? (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm whitespace-pre-line text-destructive"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          {error}
        </div>
      ) : null}
      {notice ? (
        <div
          role="status"
          className="flex items-start gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400"
        >
          <Check className="mt-0.5 size-4 shrink-0" />
          {notice}
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-3">
        {/* 1. Add shake */}
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle>1. Add shake</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="in-quality">Quality</Label>
              <Select
                id="in-quality"
                value={inQuality}
                onChange={(e) => setInQuality(e.target.value as Quality | "")}
              >
                <option value="">Choose…</option>
                {QUALITIES.map((q) => (
                  <option key={q} value={q}>
                    {QUALITY_LABEL[q]}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="in-amount">Weight</Label>
              <div className="flex gap-2">
                <Input
                  id="in-amount"
                  type="number"
                  min="0"
                  step="0.01"
                  inputMode="decimal"
                  value={inAmount}
                  onChange={(e) => setInAmount(e.target.value)}
                  placeholder="0"
                  className="text-right tabular-nums"
                />
                <Select
                  aria-label="Weight unit"
                  value={inUnit}
                  onChange={(e) => setInUnit(e.target.value as WeighUnit)}
                  className="w-20"
                >
                  {(Object.keys(WEIGH_UNITS) as WeighUnit[]).map((u) => (
                    <option key={u} value={u}>
                      {u}
                    </option>
                  ))}
                </Select>
              </div>
              {inUnit !== "g" && inGrams > 0 ? (
                <span className="text-xs text-muted-foreground">= {gramsWithPounds(inGrams)}</span>
              ) : null}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="in-note">Note (optional)</Label>
              <Input
                id="in-note"
                value={inNote}
                onChange={(e) => setInNote(e.target.value)}
                placeholder="e.g. Tuesday packing run"
              />
            </div>
            <Button onClick={addShake} disabled={isPending || !inQuality || !(inGrams > 0)}>
              Add to pot
            </Button>
          </CardContent>
        </Card>

        {/* 2. Split to brands */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>2. Split a pot to brands</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="sp-quality">Pot</Label>
                <Select
                  id="sp-quality"
                  value={quality}
                  onChange={(e) => changeQuality(e.target.value as Quality)}
                >
                  {QUALITIES.map((q) => (
                    <option key={q} value={q}>
                      {QUALITY_LABEL[q]} · {gramsWithPounds(pots[q])}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Sales period for the shares</Label>
                <div className="flex flex-wrap gap-1.5">
                  {(Object.keys(PERIOD_PRESET_LABEL) as PeriodPreset[]).map((p) => (
                    <Button
                      key={p}
                      type="button"
                      size="sm"
                      variant={preset === p ? "default" : "outline"}
                      onClick={() => applyPreset(p)}
                    >
                      {PERIOD_PRESET_LABEL[p]}
                    </Button>
                  ))}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    type="date"
                    aria-label="Period start"
                    value={from}
                    max={to}
                    onChange={(e) => {
                      setFrom(e.target.value)
                      setPreset("custom")
                      setPreview(null)
                    }}
                    className="w-40"
                  />
                  <span className="text-sm text-muted-foreground">to</span>
                  <Input
                    type="date"
                    aria-label="Period end"
                    value={to}
                    min={from}
                    max={today}
                    onChange={(e) => {
                      setTo(e.target.value)
                      setPreset("custom")
                      setPreview(null)
                    }}
                    className="w-40"
                  />
                </div>
                {preset === "since_last" ? (
                  <span className="text-xs text-muted-foreground">
                    {sinceLastHint(QUALITY_LABEL[quality].toLowerCase(), lastPeriodTo[quality], today)}
                  </span>
                ) : null}
              </div>
            </div>

            <div>
              <Button onClick={() => calculate()} disabled={isPending || !from || !to}>
                Calculate shares
              </Button>
            </div>

            {preview ? (
              <SplitPreview
                preview={preview}
                units={units}
                setUnits={setUnits}
                usage={usage}
                totalUsed={totalUsed}
                suggest={suggest}
              />
            ) : null}

            {preview && preview.brands.length > 0 && preview.total_sold_grams > 0 ? (
              <div className="flex flex-col gap-3 border-t border-border pt-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="sp-note">Note (optional)</Label>
                  <Input
                    id="sp-note"
                    value={splitNote}
                    onChange={(e) => setSplitNote(e.target.value)}
                  />
                </div>
                {overBrands.length > 0 ? (
                  <p className="text-sm text-destructive">
                    Over the share for {overBrands.map((b) => b.site_name).join(", ")}. Lower
                    those units to continue.
                  </p>
                ) : null}
                <div className="flex flex-wrap items-center gap-3">
                  <Button onClick={split} disabled={isPending || !canSplit}>
                    Make units and add to stock
                  </Button>
                  <span className="text-sm text-muted-foreground tabular-nums">
                    Uses {gramsWithPounds(totalUsed)} of {gramsWithPounds(preview.pot_grams)};{" "}
                    {gramsWithPounds(Math.max(0, preview.pot_grams - totalUsed))} stays in the pot.
                  </span>
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>

      <History
        distributions={distributions}
        entries={entries}
        pending={isPending}
        onUndo={undo}
      />
    </div>
  )
}

function withArticle(word: string) {
  return /^[aeiou]/i.test(word) ? `an ${word}` : `a ${word}`
}

function sinceLastHint(label: string, last: string | null, today: string) {
  if (!last) return `No ${label} split yet, so this uses the last 30 days.`
  if (last < today) return `Sales since the last ${label} split, which covered through ${fmtDay(last)}.`
  return `The last ${label} split already covered today, so this uses the last 30 days.`
}

function SplitPreview({
  preview,
  units,
  setUnits,
  usage,
  totalUsed,
  suggest,
}: {
  preview: Preview
  units: Record<string, string>
  setUnits: (fn: (prev: Record<string, string>) => Record<string, string>) => void
  usage: Record<string, number>
  totalUsed: number
  suggest: (siteId?: string) => void
}) {
  const label = QUALITY_LABEL[preview.quality].toLowerCase()

  if (preview.brands.length === 0)
    return (
      <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
        No brand has {withArticle(label)} shake product yet. Mark one on{" "}
        <Link href="/catalog/quality" className="underline">
          Strain quality
        </Link>{" "}
        (set its quality to {label} and tick &ldquo;Shake product&rdquo;).
      </p>
    )

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        {fmtDay(preview.period_from)} – {fmtDay(preview.period_to)}: brands sold{" "}
        <span className="font-medium text-foreground tabular-nums">
          {gramsWithPounds(preview.total_sold_grams)}
        </span>{" "}
        of {label} strains. Each brand&apos;s share of the{" "}
        <span className="font-medium text-foreground tabular-nums">
          {gramsWithPounds(preview.pot_grams)}
        </span>{" "}
        pot follows those sales.
      </p>

      {preview.total_sold_grams <= 0 ? (
        <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
          No {label} sales in this period, so there is nothing to split by. Pick a longer period,
          or check that strains have a quality on{" "}
          <Link href="/catalog/quality" className="underline">
            Strain quality
          </Link>
          .
        </p>
      ) : (
        <>
          <div className="flex justify-end">
            <Button type="button" size="sm" variant="outline" onClick={() => suggest()}>
              <Sparkles data-icon="inline-start" /> Suggest units for all
            </Button>
          </div>
          <div className="grid gap-3 xl:grid-cols-2">
            {preview.brands.map((b) => {
              const used = usage[b.site_id] ?? 0
              const over = used > b.target_grams + 1e-9
              return (
                <div key={b.site_id} className="flex flex-col gap-3 rounded-lg border border-border p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="flex min-w-0 flex-col">
                      <span className="font-medium">{b.site_name}</span>
                      <span className="text-xs text-muted-foreground tabular-nums">
                        Sold {gramsWithPounds(b.sold_grams)} · {fmtPct(b.share)}
                      </span>
                    </div>
                    <Badge variant="secondary" className="tabular-nums">
                      Share {gramsWithPounds(b.target_grams)}
                    </Badge>
                  </div>
                  {b.variants.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No shake sizes set up.</p>
                  ) : (
                    b.variants.map((v) => (
                      <div key={v.child_sku_id} className="flex items-center justify-between gap-3">
                        <div className="flex min-w-0 flex-col">
                          <span className="text-sm font-medium">
                            {v.variant_label?.trim() || weightLabel(v.grams_per_unit)}
                          </span>
                          <span className="truncate text-xs text-muted-foreground">
                            {v.sku ?? v.product_name} · {v.on_hand} on hand
                          </span>
                        </div>
                        <Input
                          type="number"
                          min="0"
                          step="1"
                          inputMode="numeric"
                          aria-label={`${b.site_name} ${v.variant_label ?? v.grams_per_unit + "g"} units`}
                          aria-invalid={over}
                          value={units[v.child_sku_id] ?? ""}
                          onChange={(e) =>
                            setUnits((prev) => ({ ...prev, [v.child_sku_id]: e.target.value }))
                          }
                          className="w-20 text-right tabular-nums"
                          placeholder="0"
                        />
                      </div>
                    ))
                  )}
                  <div className="flex items-center justify-between border-t border-border pt-2 text-xs">
                    <span
                      className={cn(
                        "tabular-nums",
                        over ? "font-medium text-destructive" : "text-muted-foreground",
                      )}
                    >
                      {gramsWithPounds(used)} of {gramsWithPounds(b.target_grams)}
                    </span>
                    {b.variants.length > 0 ? (
                      <Button type="button" size="xs" variant="ghost" onClick={() => suggest(b.site_id)}>
                        Suggest
                      </Button>
                    ) : null}
                  </div>
                </div>
              )
            })}
          </div>
          {totalUsed === 0 ? (
            <p className="text-xs text-muted-foreground">
              Enter units per size, or use Suggest. Grams that don&apos;t fill a whole unit stay in
              the pot for the next split.
            </p>
          ) : null}
        </>
      )}
    </div>
  )
}

function History({
  distributions,
  entries,
  pending,
  onUndo,
}: {
  distributions: DistributionRow[]
  entries: EntryRow[]
  pending: boolean
  onUndo: (kind: "distribution" | "entry", id: string, what: string) => void
}) {
  return (
    <div className="grid gap-6 2xl:grid-cols-3">
      <Card className="2xl:col-span-2">
        <CardHeader>
          <CardTitle>Recent splits</CardTitle>
        </CardHeader>
        <CardContent>
          {distributions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No splits yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Pot</TableHead>
                  <TableHead>Sales period</TableHead>
                  <TableHead>Brands</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {distributions.map((d) => (
                  <TableRow key={d.id} className={cn(d.reversed && "opacity-50")}>
                    <TableCell className="whitespace-nowrap">{dateTime.format(new Date(d.createdAt))}</TableCell>
                    <TableCell>{QUALITY_LABEL[d.quality]}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      {fmtDay(d.periodFrom)} – {fmtDay(d.periodTo)}
                    </TableCell>
                    <TableCell className="min-w-40 text-xs whitespace-normal">
                      {d.brands
                        .filter((b) => b.grams > 0 || b.share > 0)
                        .map((b) => `${b.name} ${gramsWithPounds(b.grams)} (${fmtPct(b.share)})`)
                        .join(" · ")}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{gramsWithPounds(d.totalGrams)}</TableCell>
                    <TableCell className="text-right">
                      {d.reversed ? (
                        <Badge variant="outline">Undone</Badge>
                      ) : (
                        <Button
                          size="xs"
                          variant="ghost"
                          disabled={pending}
                          onClick={() =>
                            onUndo(
                              "distribution",
                              d.id,
                              `the ${QUALITY_LABEL[d.quality].toLowerCase()} split of ${gramsWithPounds(d.totalGrams)}`,
                            )
                          }
                        >
                          <Undo2 data-icon="inline-start" /> Undo
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Shake added</CardTitle>
        </CardHeader>
        <CardContent>
          {entries.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing added yet.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {entries.map((e) => (
                <li
                  key={e.id}
                  className={cn("flex items-center justify-between gap-3 py-2", e.reversed && "opacity-50")}
                >
                  <div className="flex min-w-0 flex-col">
                    <span className="text-sm tabular-nums">
                      {gramsWithPounds(e.grams)} · {QUALITY_LABEL[e.quality]}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      {dateTime.format(new Date(e.createdAt))}
                      {e.note ? ` · ${e.note}` : ""}
                    </span>
                  </div>
                  {e.reversed ? (
                    <Badge variant="outline">Undone</Badge>
                  ) : (
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={pending}
                      onClick={() =>
                        onUndo(
                          "entry",
                          e.id,
                          `adding ${gramsWithPounds(e.grams)} of ${QUALITY_LABEL[e.quality].toLowerCase()} shake`,
                        )
                      }
                    >
                      <Undo2 data-icon="inline-start" /> Undo
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
