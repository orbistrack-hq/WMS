"use client"

import { useEffect, useMemo, useRef, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import {
  AlertCircle,
  Check,
  ClipboardCheck,
  PackageCheck,
  ShieldAlert,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { matchByCode } from "@/lib/packing/aggregate"
import { SCANNING_ENABLED } from "@/lib/flags"
import { ScanInput } from "../scan-input"
import { packGroup } from "../actions"

export type PackScanItem = {
  childSkuId: string
  sku: string | null
  barcode: string | null
  name: string
  required: number
}

export function PackConfirm({
  groupId,
  initialNotes,
  needsPacking,
  pickComplete,
  items,
  isOperator,
}: {
  groupId: string
  initialNotes: string | null
  needsPacking: boolean
  pickComplete: boolean
  items: PackScanItem[]
  isOperator: boolean
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [notes, setNotes] = useState(initialNotes ?? "")

  // Scanned units per child SKU, plus an operator escape hatch.
  const [scanned, setScanned] = useState<Map<string, number>>(new Map())
  const [overridden, setOverridden] = useState(false)
  const [scanMsg, setScanMsg] = useState<{
    kind: "ok" | "err"
    text: string
  } | null>(null)
  const scannedRef = useRef(scanned)
  // Mirror the latest scanned map into a ref for the scan handler, updated in an
  // effect rather than during render (react-hooks/refs).
  useEffect(() => {
    scannedRef.current = scanned
  }, [scanned])

  // Packing is gated first on picking, then on scanning every unit. With
  // scanning hidden, the scan gate drops away and packing is allowed once
  // picking is done.
  const blockedOnPicking = needsPacking && !pickComplete
  const showScan =
    SCANNING_ENABLED && needsPacking && !blockedOnPicking && items.length > 0

  const { scannedTotal, requiredTotal, scanComplete } = useMemo(() => {
    let s = 0
    let req = 0
    let complete = true
    for (const it of items) {
      const n = Math.min(scanned.get(it.childSkuId) ?? 0, it.required)
      s += n
      req += it.required
      if (n < it.required) complete = false
    }
    return { scannedTotal: s, requiredTotal: req, scanComplete: complete }
  }, [items, scanned])

  const canConfirm =
    !isPending &&
    !blockedOnPicking &&
    (!needsPacking || !showScan || scanComplete || overridden)

  function onScan(code: string) {
    if (!showScan) return
    const match = matchByCode(items, code)
    if (!match) {
      setScanMsg({
        kind: "err",
        text: `No item matches “${code}” in this group.`,
      })
      return
    }
    const have = scannedRef.current.get(match.childSkuId) ?? 0
    if (have >= match.required) {
      setScanMsg({
        kind: "err",
        text: `${match.name} is already fully scanned (${match.required}).`,
      })
      return
    }
    const next = have + 1
    setScanned((m) => new Map(m).set(match.childSkuId, next))
    setScanMsg({
      kind: "ok",
      text: `✓ ${match.name} · ${next}/${match.required}`,
    })
  }

  function submit() {
    setError(null)
    setSaved(false)
    startTransition(async () => {
      const res = await packGroup(groupId, notes || null)
      if (!res.ok) setError(res.error)
      else {
        setSaved(true)
        router.refresh()
      }
    })
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Scan-to-pack: every required unit must be scanned (or overridden). */}
      {showScan ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Scan to pack</span>
            <span className="tabular-nums text-xs text-muted-foreground">
              {scannedTotal} / {requiredTotal} units
            </span>
          </div>

          <ScanInput
            onScan={onScan}
            disabled={scanComplete || overridden}
            placeholder="Scan each item before packing…"
          />

          {scanMsg ? (
            <p
              className={
                "text-xs " +
                (scanMsg.kind === "ok"
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-destructive")
              }
            >
              {scanMsg.text}
            </p>
          ) : null}

          <ul className="flex flex-col gap-1">
            {items.map((it) => {
              const n = Math.min(scanned.get(it.childSkuId) ?? 0, it.required)
              const done = n >= it.required
              return (
                <li
                  key={it.childSkuId}
                  className="flex items-center justify-between gap-2 text-sm"
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    {done ? (
                      <Check className="size-3.5 shrink-0 text-emerald-600" />
                    ) : (
                      <span className="size-3.5 shrink-0" />
                    )}
                    <span className="truncate">{it.name}</span>
                  </span>
                  <span
                    className={
                      "shrink-0 tabular-nums " +
                      (done ? "text-emerald-600" : "text-muted-foreground")
                    }
                  >
                    {n}/{it.required}
                  </span>
                </li>
              )
            })}
          </ul>

          {overridden ? (
            <p className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400">
              <ShieldAlert className="size-3.5" /> Scan check overridden.
            </p>
          ) : isOperator && !scanComplete ? (
            <Button
              size="sm"
              variant="ghost"
              className="self-start text-muted-foreground"
              onClick={() => setOverridden(true)}
            >
              <ShieldAlert data-icon="inline-start" /> Pack without scanning
              (override)
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-col gap-1">
        <Label htmlFor="packing-notes">Packing notes</Label>
        <Textarea
          id="packing-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Fragile, special handling, partial pack…"
        />
      </div>

      {error ? (
        <div className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      <div className="flex items-center gap-2">
        <Button onClick={submit} disabled={!canConfirm}>
          <PackageCheck data-icon="inline-start" />
          {needsPacking ? "Confirm packed" : "Save note"}
        </Button>
        {saved ? (
          <span className="flex items-center gap-1 text-sm text-emerald-600">
            <Check className="size-4" /> Saved
          </span>
        ) : null}
      </div>

      {blockedOnPicking ? (
        <div className="flex flex-col items-start gap-1.5 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          <span>Finish picking this group before packing it.</span>
          <Link
            href={`/packing/${groupId}/pick`}
            className="inline-flex items-center gap-1 font-medium underline"
          >
            <ClipboardCheck className="size-3.5" /> Go to picking
          </Link>
        </div>
      ) : showScan && !scanComplete && !overridden ? (
        <p className="text-xs text-muted-foreground">
          Scan every item to enable packing. Damaged label? Type the SKU, or an
          operator can override.
        </p>
      ) : needsPacking ? (
        <p className="text-xs text-muted-foreground">
          Confirming advances every open order in this group to{" "}
          <span className="font-medium">Packed</span>. Fulfillment and shipping
          happen from the order.
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          All orders in this group are already packed.
        </p>
      )}
    </div>
  )
}
