"use client"

import { useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { AlertCircle, Lock, Pencil, Plus, Trash2, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { formatCurrency, formatDate } from "@/lib/format"
import {
  deleteFeeSchedule,
  publishFeeSchedule,
  updateFeeSchedule,
} from "./actions"

export type ScheduleRow = {
  id: string
  effectiveFrom: string
  firstUnitRate: number
  additionalUnitRate: number
  note: string | null
  createdAt: string
  /** Orders this rate has billed. Non-zero means the DB has frozen the row. */
  chargeCount: number
  isCurrent: boolean
}

/** The tiered maths, mirroring pick_fee_amount() in the database. */
function feeFor(units: number, first: number, additional: number): number {
  if (units <= 0) return 0
  return first + (units - 1) * additional
}

const PREVIEW_UNITS = [1, 2, 5, 10]

export function PickFeeEditor({
  schedules,
  canManage,
  today,
}: {
  schedules: ScheduleRow[]
  canManage: boolean
  today: string
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const current = schedules.find((s) => s.isCurrent) ?? null
  const queued = schedules.filter((s) => s.effectiveFrom > today)

  // The new-rate form, seeded from whatever is in force so a change is a nudge
  // rather than a re-entry.
  const [open, setOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [first, setFirst] = useState("")
  const [additional, setAdditional] = useState("")
  const [from, setFrom] = useState(today)
  const [note, setNote] = useState("")

  function startNew() {
    setError(null)
    setEditingId(null)
    setFirst(current ? String(current.firstUnitRate) : "")
    setAdditional(current ? String(current.additionalUnitRate) : "")
    setFrom(today)
    setNote("")
    setOpen(true)
  }

  function startEdit(s: ScheduleRow) {
    setError(null)
    setEditingId(s.id)
    setFirst(String(s.firstUnitRate))
    setAdditional(String(s.additionalUnitRate))
    setFrom(s.effectiveFrom)
    setNote(s.note ?? "")
    setOpen(true)
  }

  function close() {
    setOpen(false)
    setEditingId(null)
    setError(null)
  }

  const draftFirst = Number(first)
  const draftAdditional = Number(additional)
  const draftValid =
    Number.isFinite(draftFirst) &&
    draftFirst >= 0 &&
    Number.isFinite(draftAdditional) &&
    draftAdditional >= 0 &&
    from !== ""

  const preview = useMemo(
    () =>
      PREVIEW_UNITS.map((u) => ({
        units: u,
        now: current ? feeFor(u, current.firstUnitRate, current.additionalUnitRate) : null,
        next: draftValid ? feeFor(u, draftFirst, draftAdditional) : null,
      })),
    [current, draftValid, draftFirst, draftAdditional],
  )

  function save() {
    setError(null)
    startTransition(async () => {
      const res = editingId
        ? await updateFeeSchedule(editingId, draftFirst, draftAdditional, from, note)
        : await publishFeeSchedule(draftFirst, draftAdditional, from, note)
      if (!res.ok) setError(res.error)
      else {
        close()
        router.refresh()
      }
    })
  }

  function remove(id: string) {
    setError(null)
    startTransition(async () => {
      const res = await deleteFeeSchedule(id)
      if (!res.ok) setError(res.error)
      else router.refresh()
    })
  }

  return (
    <div className="flex flex-col gap-4">
      {error ? (
        <div className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      {/* ---------------------------------------------------------------- */}
      {/* Current rate                                                      */}
      {/* ---------------------------------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            Current rate
            {current ? (
              <Badge variant="info">
                since {formatDate(current.effectiveFrom)}
              </Badge>
            ) : (
              <Badge variant="destructive">none in force</Badge>
            )}
          </CardTitle>
          <CardDescription>
            {current
              ? "Applies to every order fulfilled from this date until a new rate takes over."
              : "No rate is in force, so fulfilment will fail when it tries to bill. Publish one."}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-border px-3 py-2">
              <div className="text-xs text-muted-foreground">First unit</div>
              <div className="text-xl font-semibold tabular-nums">
                {current ? formatCurrency(current.firstUnitRate) : "—"}
              </div>
            </div>
            <div className="rounded-lg border border-border px-3 py-2">
              <div className="text-xs text-muted-foreground">
                Each additional unit
              </div>
              <div className="text-xl font-semibold tabular-nums">
                {current ? formatCurrency(current.additionalUnitRate) : "—"}
              </div>
            </div>
          </div>

          {current ? (
            <p className="text-sm text-muted-foreground">
              A {PREVIEW_UNITS[0]}-unit order bills{" "}
              <span className="font-medium text-foreground tabular-nums">
                {formatCurrency(
                  feeFor(1, current.firstUnitRate, current.additionalUnitRate),
                )}
              </span>
              ; a 5-unit order bills{" "}
              <span className="font-medium text-foreground tabular-nums">
                {formatCurrency(
                  feeFor(5, current.firstUnitRate, current.additionalUnitRate),
                )}
              </span>
              .
            </p>
          ) : null}

          {canManage && !open ? (
            <div>
              <Button size="sm" onClick={startNew}>
                <Plus /> Change the rate
              </Button>
            </div>
          ) : null}
          {!canManage ? (
            <p className="text-xs text-muted-foreground">
              Only an admin or manager can change the pick fee.
            </p>
          ) : null}
        </CardContent>
      </Card>

      {/* ---------------------------------------------------------------- */}
      {/* New / edit rate form                                              */}
      {/* ---------------------------------------------------------------- */}
      {canManage && open ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {editingId ? "Edit queued rate" : "New rate"}
            </CardTitle>
            <CardDescription>
              This is added as a new dated rate. Orders already fulfilled and
              billed keep the rate they were charged — nothing in past reports
              moves.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="first-rate">First unit ($)</Label>
                <Input
                  id="first-rate"
                  type="number"
                  min="0"
                  step="0.01"
                  inputMode="decimal"
                  value={first}
                  onChange={(e) => setFirst(e.target.value)}
                  disabled={isPending}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="additional-rate">
                  Each additional unit ($)
                </Label>
                <Input
                  id="additional-rate"
                  type="number"
                  min="0"
                  step="0.01"
                  inputMode="decimal"
                  value={additional}
                  onChange={(e) => setAdditional(e.target.value)}
                  disabled={isPending}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="effective-from">Starts on</Label>
                <Input
                  id="effective-from"
                  type="date"
                  min={today}
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                  disabled={isPending}
                />
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="rate-note">Note (optional)</Label>
              <Textarea
                id="rate-note"
                rows={2}
                placeholder="Why the rate changed — shown in the history below."
                value={note}
                onChange={(e) => setNote(e.target.value)}
                disabled={isPending}
              />
            </div>

            {/* What it means in money, before anyone commits to it. */}
            <div className="rounded-lg border border-border">
              <div className="border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground">
                What an order would bill
              </div>
              <ul className="divide-y divide-border text-sm">
                {preview.map((p) => (
                  <li
                    key={p.units}
                    className="flex items-center justify-between gap-2 px-3 py-1.5"
                  >
                    <span className="text-muted-foreground">
                      {p.units} unit{p.units === 1 ? "" : "s"}
                    </span>
                    <span className="flex items-center gap-2 tabular-nums">
                      <span className="text-muted-foreground line-through">
                        {p.now === null ? "—" : formatCurrency(p.now)}
                      </span>
                      <span className="font-medium">
                        {p.next === null ? "—" : formatCurrency(p.next)}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>

            {from > today ? (
              <p className="text-xs text-muted-foreground">
                Queued: orders fulfilled before {formatDate(from)} still bill the
                current rate.
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Takes effect immediately. Orders fulfilled earlier today keep the
                rate they were charged.
              </p>
            )}

            <div className="flex items-center gap-2">
              <Button onClick={save} disabled={!draftValid || isPending}>
                {editingId ? "Save rate" : "Publish rate"}
              </Button>
              <Button variant="ghost" onClick={close} disabled={isPending}>
                <X /> Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* ---------------------------------------------------------------- */}
      {/* History                                                           */}
      {/* ---------------------------------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Rate history</CardTitle>
          <CardDescription>
            Every rate that has ever applied. A rate that has billed orders is
            locked — the record of what was charged has to stay true.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
            {schedules.map((s) => {
              const frozen = s.chargeCount > 0
              const isQueued = s.effectiveFrom > today
              return (
                <li
                  key={s.id}
                  className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"
                >
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium tabular-nums">
                        {formatCurrency(s.firstUnitRate)} +{" "}
                        {formatCurrency(s.additionalUnitRate)}/unit
                      </span>
                      {s.isCurrent ? (
                        <Badge variant="info">Current</Badge>
                      ) : isQueued ? (
                        <Badge variant="warning">Scheduled</Badge>
                      ) : (
                        <Badge variant="muted">Past</Badge>
                      )}
                      {frozen ? (
                        <Badge variant="secondary" className="gap-1">
                          <Lock className="size-3" />
                          {s.chargeCount} order
                          {s.chargeCount === 1 ? "" : "s"} billed
                        </Badge>
                      ) : null}
                    </div>
                    <span className="text-xs text-muted-foreground">
                      From {formatDate(s.effectiveFrom)}
                      {s.note ? ` · ${s.note}` : ""}
                    </span>
                  </div>

                  {canManage && !frozen && isQueued ? (
                    <div className="flex items-center gap-1.5">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => startEdit(s)}
                        disabled={isPending}
                      >
                        <Pencil /> Edit
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label="Cancel this scheduled rate"
                        onClick={() => remove(s.id)}
                        disabled={isPending}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  ) : null}
                </li>
              )
            })}
            {schedules.length === 0 ? (
              <li className="px-3 py-6 text-center text-sm text-muted-foreground">
                No rates yet.
              </li>
            ) : null}
          </ul>
        </CardContent>
      </Card>
    </div>
  )
}
