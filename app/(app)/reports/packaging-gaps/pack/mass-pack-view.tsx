"use client"

import { useState, useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { AlertCircle, Check, PackageCheck, Plus, Trash2 } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { formatCurrency } from "@/lib/format"

import { recordGroupPackaging } from "../actions"

export type PackTypeOption = {
  id: string
  name: string
  kind: string
  unitCost: number
}

export type MassPackGroup = {
  groupId: string
  label: string
  orderNumbers: string[]
  seededLines: {
    typeId: string
    typeName: string
    kind: string
    unitCost: number
    qty: number
  }[]
  unknownWeightUnits: number
  existingCost: number
}

const KIND_LABEL: Record<string, string> = {
  box: "Box",
  shipping_label: "Label",
  jar: "Jar",
  jar_label: "Jar label",
  vacuum_bag: "Vacuum bag",
  mylar_bag: "Mylar bag",
  custom: "Custom",
}

type Line = {
  typeId: string
  typeName: string
  kind: string
  unitCost: number
  qty: string
}

export function MassPackView({
  groups,
  packagingTypes,
}: {
  groups: MassPackGroup[]
  packagingTypes: PackTypeOption[]
}) {
  const router = useRouter()
  const [inputs, setInputs] = useState<Record<string, Line[]>>(() =>
    Object.fromEntries(
      groups.map((g) => [
        g.groupId,
        g.seededLines.map((l) => ({
          typeId: l.typeId,
          typeName: l.typeName,
          kind: l.kind,
          unitCost: l.unitCost,
          qty: String(l.qty),
        })),
      ]),
    ),
  )
  const [addType, setAddType] = useState(packagingTypes[0]?.id ?? "")
  const [recorded, setRecorded] = useState<Set<string>>(new Set())
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function setQty(groupId: string, typeId: string, qty: string) {
    setInputs((prev) => ({
      ...prev,
      [groupId]: (prev[groupId] ?? []).map((l) =>
        l.typeId === typeId ? { ...l, qty } : l,
      ),
    }))
  }
  function removeLine(groupId: string, typeId: string) {
    setInputs((prev) => ({
      ...prev,
      [groupId]: (prev[groupId] ?? []).filter((l) => l.typeId !== typeId),
    }))
  }
  function addLine(groupId: string) {
    const t = packagingTypes.find((p) => p.id === addType)
    if (!t) return
    setInputs((prev) => {
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
          { typeId: t.id, typeName: t.name, kind: t.kind, unitCost: t.unitCost, qty: "1" },
        ],
      }
    })
  }

  function linesToPayload(groupId: string) {
    return (inputs[groupId] ?? [])
      .map((l) => ({ packagingTypeId: l.typeId, quantity: Number(l.qty) }))
      .filter((l) => l.quantity > 0)
  }

  function groupCost(groupId: string) {
    return (inputs[groupId] ?? []).reduce(
      (s, l) => s + (Number(l.qty) || 0) * l.unitCost,
      0,
    )
  }

  async function recordOne(groupId: string): Promise<boolean> {
    const res = await recordGroupPackaging(groupId, linesToPayload(groupId))
    if (!res.ok) {
      setError(`Group ${groupId.slice(0, 8)}: ${res.error}`)
      return false
    }
    if (res.failed > 0) {
      setError(
        `Some lines couldn't be recorded${res.firstError ? `: ${res.firstError}` : ""}. Check packaging stock.`,
      )
    }
    setRecorded((prev) => new Set(prev).add(groupId))
    return true
  }

  function recordGroup(groupId: string) {
    setError(null)
    setBusyId(groupId)
    startTransition(async () => {
      await recordOne(groupId)
      setBusyId(null)
    })
  }

  function recordAll() {
    setError(null)
    startTransition(async () => {
      for (const g of groups) {
        if (recorded.has(g.groupId)) continue
        if (linesToPayload(g.groupId).length === 0) continue
        const ok = await recordOne(g.groupId)
        if (!ok) break
      }
      router.refresh()
    })
  }

  const doneCount = recorded.size
  const remaining = groups.filter((g) => !recorded.has(g.groupId)).length

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-4 py-3">
        <span className="text-sm font-medium">
          {doneCount} of {groups.length} recorded
        </span>
        <div className="flex items-center gap-2">
          {error ? (
            <span className="flex items-center gap-1.5 text-sm text-destructive">
              <AlertCircle className="size-4" /> {error}
            </span>
          ) : null}
          <Button size="sm" onClick={recordAll} disabled={pending || remaining === 0}>
            <PackageCheck data-icon="inline-start" />
            {pending ? "Recording…" : `Record all remaining (${remaining})`}
          </Button>
        </div>
      </div>

      {groups.map((g) => {
        const isDone = recorded.has(g.groupId)
        const lines = inputs[g.groupId] ?? []
        return (
          <div
            key={g.groupId}
            className={
              "rounded-lg border p-3 " +
              (isDone ? "border-emerald-500/50 bg-emerald-500/5" : "border-border")
            }
          >
            <div className="mb-2 flex flex-wrap items-center gap-2">
              {g.orderNumbers.map((n) => (
                <Badge key={n} variant="secondary">
                  {n}
                </Badge>
              ))}
              <span className="truncate text-sm text-muted-foreground">
                {g.label}
              </span>
              {g.orderNumbers.length > 1 ? (
                <Badge variant="muted">combined ×{g.orderNumbers.length}</Badge>
              ) : null}
              {isDone ? (
                <Badge variant="success" className="ml-auto">
                  <Check className="size-3.5" /> Recorded
                </Badge>
              ) : null}
            </div>

            {g.existingCost > 0 ? (
              <p className="mb-2 text-xs text-muted-foreground">
                {formatCurrency(g.existingCost)} already recorded on this group —
                add below only if something&apos;s missing.
              </p>
            ) : null}

            {!isDone ? (
              <div className="flex flex-col gap-2 rounded-md border border-dashed border-border p-2">
                {lines.length > 0 ? (
                  <div className="flex flex-col gap-1.5">
                    {lines.map((line) => (
                      <div key={line.typeId} className="flex items-center gap-2">
                        <span className="flex-1 truncate text-xs">
                          {line.typeName}
                          <span className="ml-1 text-muted-foreground">
                            {KIND_LABEL[line.kind] ?? line.kind}
                          </span>
                        </span>
                        <Input
                          type="number"
                          min="0"
                          step="1"
                          aria-label={`${line.typeName} quantity`}
                          value={line.qty}
                          onChange={(e) =>
                            setQty(g.groupId, line.typeId, e.target.value)
                          }
                          className="h-8 w-14 text-xs"
                        />
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={`Remove ${line.typeName}`}
                          onClick={() => removeLine(g.groupId, line.typeId)}
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

                {g.unknownWeightUnits > 0 ? (
                  <p className="text-xs text-amber-700 dark:text-amber-400">
                    {g.unknownWeightUnits} unit
                    {g.unknownWeightUnits === 1 ? "" : "s"} had no matching weight
                    rule — add their packaging by hand.
                  </p>
                ) : null}

                <div className="flex items-end gap-2">
                  <Select
                    className="h-8 flex-1 text-xs"
                    aria-label="Packaging type to add"
                    value={addType}
                    onChange={(e) => setAddType(e.target.value)}
                  >
                    {packagingTypes.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name} ({KIND_LABEL[t.kind] ?? t.kind})
                      </option>
                    ))}
                  </Select>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => addLine(g.groupId)}
                    disabled={packagingTypes.length === 0}
                  >
                    <Plus data-icon="inline-start" /> Add
                  </Button>
                </div>

                <div className="flex items-center justify-between border-t pt-2">
                  <span className="text-xs text-muted-foreground">
                    Packaging cost:{" "}
                    <span className="font-medium tabular-nums text-foreground">
                      {formatCurrency(groupCost(g.groupId))}
                    </span>
                  </span>
                  <Button
                    size="sm"
                    onClick={() => recordGroup(g.groupId)}
                    disabled={pending || linesToPayload(g.groupId).length === 0}
                  >
                    {pending && busyId === g.groupId
                      ? "Recording…"
                      : "Record packaging"}
                  </Button>
                </div>
              </div>
            ) : (
              <Link
                href={`/packing/${g.groupId}`}
                className="text-xs text-muted-foreground underline underline-offset-4"
              >
                View / edit on the pack screen
              </Link>
            )}
          </div>
        )
      })}
    </div>
  )
}
