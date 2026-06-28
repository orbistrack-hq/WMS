"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  Check,
  Minus,
  PackageCheck,
  Plus,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { matchByCode } from "@/lib/packing/aggregate"
import { SCANNING_ENABLED } from "@/lib/flags"
import { ScanInput } from "../../scan-input"
import { claimPick, setPickQty } from "../../actions"

export type PickRow = {
  childSkuId: string | null
  sku: string | null
  bin: string | null
  barcode: string | null
  name: string
  required: number
  qtyPicked: number
  short: boolean
}

const rowDone = (r: PickRow) => r.short || r.qtyPicked >= r.required

export function PickRunner({
  groupId,
  groupOpen,
  customerName,
  siteName,
  orderNumbers,
  totalUnits,
  rows: initialRows,
  initialHolderId,
  initialHolderName,
  currentUserId,
}: {
  groupId: string
  groupOpen: boolean
  customerName: string
  siteName: string | null
  orderNumbers: string[]
  totalUnits: number
  rows: PickRow[]
  initialHolderId: string | null
  initialHolderName: string | null
  currentUserId: string | null
}) {
  const [rows, setRows] = useState<PickRow[]>(initialRows)
  const [busy, setBusy] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [scanMsg, setScanMsg] = useState<{
    kind: "ok" | "err"
    text: string
  } | null>(null)

  // Mirror rows in a ref so a scan resolves against the freshest counts even
  // between renders (rapid back-to-back scans).
  const rowsRef = useRef(rows)
  useEffect(() => {
    rowsRef.current = rows
  }, [rows])

  const startsSelf =
    !!currentUserId && initialHolderId === currentUserId
  const [canEdit, setCanEdit] = useState(startsSelf || !initialHolderId)
  const [holderName, setHolderName] = useState<string | null>(
    startsSelf ? null : initialHolderName,
  )
  const [claiming, setClaiming] = useState(false)

  // Claim the group on mount if it's free; if someone else holds it, wait for
  // an explicit take-over instead of stealing it.
  useEffect(() => {
    if (!groupOpen) return
    if (startsSelf) return
    if (initialHolderId) return // held by someone else — show take-over
    void doClaim(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function doClaim(takeover: boolean) {
    setClaiming(true)
    setError(null)
    const res = await claimPick(groupId, takeover)
    setClaiming(false)
    if (!res.ok) {
      setError(res.error)
      return
    }
    if (res.claim.isSelf) {
      setCanEdit(true)
      setHolderName(null)
    } else {
      setCanEdit(false)
      setHolderName(res.claim.holderName)
    }
  }

  async function update(row: PickRow, qty: number, short: boolean) {
    if (!row.childSkuId || !canEdit || !groupOpen) return
    const id = row.childSkuId
    const optimistic = Math.max(0, Math.min(row.required, qty))
    // Optimistic: show the new count immediately, reconcile with the server's
    // clamped value when it returns.
    setRows((rs) =>
      rs.map((r) =>
        r.childSkuId === id ? { ...r, qtyPicked: optimistic, short } : r,
      ),
    )
    setBusy((b) => new Set(b).add(id))
    setError(null)
    const res = await setPickQty(groupId, id, qty, short)
    setBusy((b) => {
      const next = new Set(b)
      next.delete(id)
      return next
    })
    if (!res.ok) {
      setError(res.error)
      return
    }
    setRows((rs) =>
      rs.map((r) =>
        r.childSkuId === id
          ? { ...r, qtyPicked: res.result.qtyPicked, short: res.result.short }
          : r,
      ),
    )
  }

  // Resolve a scanned/typed code to a line and bump it by one.
  function onScan(code: string) {
    if (!canEdit || !groupOpen) return
    const match = matchByCode(rowsRef.current, code)
    if (!match || !match.childSkuId) {
      setScanMsg({
        kind: "err",
        text: `No item matches “${code}”. Type the SKU, or use +/− on the row.`,
      })
      return
    }
    if (match.qtyPicked >= match.required) {
      setScanMsg({
        kind: "err",
        text: `${match.name} is already fully picked (${match.required}).`,
      })
      return
    }
    const next = match.qtyPicked + 1
    setScanMsg({
      kind: "ok",
      text: `+1 ${match.name} · ${next}/${match.required}`,
    })
    void update(match, next, false)
  }

  const { picked, required, doneCount, complete } = useMemo(() => {
    let picked = 0
    let required = 0
    let doneCount = 0
    for (const r of rows) {
      picked += Math.min(r.qtyPicked, r.required)
      required += r.required
      if (rowDone(r)) doneCount += 1
    }
    return {
      picked,
      required,
      doneCount,
      complete: rows.length > 0 && doneCount === rows.length,
    }
  }, [rows])

  const pct = required > 0 ? Math.round((picked / required) * 100) : 0

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-4">
      <Link
        href={`/packing/${groupId}`}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> Back to group
      </Link>

      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Pick</h1>
        <p className="text-sm text-muted-foreground">
          {customerName}
          {siteName ? ` · ${siteName}` : ""}
          {orderNumbers.length ? ` · ${orderNumbers.join(", ")}` : ""}
        </p>
      </div>

      {/* Progress */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between text-sm">
          <span className="font-medium">
            {doneCount} / {rows.length} SKUs
          </span>
          <span className="tabular-nums text-muted-foreground">
            {picked} / {required} units
          </span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      {/* Group already packed */}
      {!groupOpen ? (
        <div className="rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
          This group is already past picking. Open it from the{" "}
          <Link href={`/packing/${groupId}`} className="underline">
            group page
          </Link>
          .
        </div>
      ) : null}

      {/* Someone else is picking */}
      {groupOpen && !canEdit ? (
        <div className="flex flex-col gap-2 rounded-lg bg-amber-500/10 px-3 py-2.5 text-sm">
          <div className="flex items-start gap-2 font-medium text-amber-700 dark:text-amber-400">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>
              {holderName ?? "Someone"} is picking this group. You can watch, or
              take over to make changes.
            </span>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="self-start"
            disabled={claiming}
            onClick={() => doClaim(true)}
          >
            Take over picking
          </Button>
        </div>
      ) : null}

      {error ? (
        <div className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      {/* Scan to pick */}
      {SCANNING_ENABLED && groupOpen && canEdit ? (
        <div className="flex flex-col gap-1.5">
          <ScanInput onScan={onScan} />
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
          ) : (
            <p className="text-xs text-muted-foreground">
              Scan an item to add one. No label? Type the SKU and press Enter, or
              use the buttons below.
            </p>
          )}
        </div>
      ) : null}

      {/* Lines, in walking-route order */}
      <div className="flex flex-col gap-2">
        {rows.map((r, i) => {
          const id = r.childSkuId ?? `orphan-${i}`
          const isBusy = r.childSkuId ? busy.has(r.childSkuId) : false
          const done = rowDone(r)
          const disabled = !canEdit || isBusy || !r.childSkuId || !groupOpen
          return (
            <div
              key={id}
              className={
                "flex items-center gap-3 rounded-lg border p-3 " +
                (r.short
                  ? "border-amber-400/60 bg-amber-500/5"
                  : done
                    ? "border-emerald-500/50 bg-emerald-500/5"
                    : "border-border")
              }
            >
              <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex items-center gap-1.5">
                  {r.bin ? (
                    <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs tabular-nums">
                      {r.bin}
                    </span>
                  ) : null}
                  <span className="truncate font-medium">{r.name}</span>
                  {r.short ? <Badge variant="warning">Short</Badge> : null}
                  {!r.short && done ? (
                    <Check className="size-4 shrink-0 text-emerald-600" />
                  ) : null}
                </div>
                <span className="truncate text-xs tabular-nums text-muted-foreground">
                  {r.sku ?? "no SKU"}
                </span>
              </div>

              <div className="flex shrink-0 items-center gap-1.5">
                <Button
                  size="icon"
                  variant="outline"
                  aria-label="One fewer"
                  disabled={disabled || r.qtyPicked <= 0}
                  onClick={() => update(r, r.qtyPicked - 1, false)}
                >
                  <Minus />
                </Button>
                <span className="w-14 text-center text-base font-semibold tabular-nums">
                  {r.qtyPicked}
                  <span className="text-muted-foreground"> / {r.required}</span>
                </span>
                <Button
                  size="icon"
                  variant="outline"
                  aria-label="One more"
                  disabled={disabled || r.qtyPicked >= r.required}
                  onClick={() => update(r, r.qtyPicked + 1, false)}
                >
                  <Plus />
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={disabled || (r.qtyPicked >= r.required && !r.short)}
                  onClick={() => update(r, r.required, false)}
                >
                  All
                </Button>
                <Button
                  size="sm"
                  variant={r.short ? "secondary" : "outline"}
                  className={
                    r.short
                      ? "text-amber-700 dark:text-amber-400"
                      : "text-muted-foreground"
                  }
                  aria-pressed={r.short}
                  disabled={disabled}
                  onClick={() => update(r, r.qtyPicked, !r.short)}
                  title="Out of stock — mark short"
                >
                  Short
                </Button>
              </div>
            </div>
          )
        })}
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing to pick — no active orders in this group.
          </p>
        ) : null}
      </div>

      {/* Complete → packing */}
      {complete ? (
        <div className="flex items-center justify-between gap-3 rounded-lg bg-emerald-500/10 px-3 py-3 text-sm">
          <span className="flex items-center gap-2 font-medium text-emerald-700 dark:text-emerald-400">
            <Check className="size-4" /> Picking complete · {totalUnits} units
          </span>
          <Link
            href={`/packing/${groupId}`}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            <PackageCheck className="size-4" /> Pack group
          </Link>
        </div>
      ) : null}
    </div>
  )
}
