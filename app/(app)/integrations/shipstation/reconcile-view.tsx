"use client"

import { useState, useTransition } from "react"
import { RefreshCw, CheckCircle2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { formatDateTime } from "@/lib/format"
import { runShipStationReconcile } from "./actions"
import type { ReconcileResult, ReconcileRow } from "@/lib/shipstation/reconcile"

function ageLabel(mins: number | null): string {
  if (mins == null) return ""
  if (mins < 60) return `${mins}m`
  const h = Math.floor(mins / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

function RowList({ rows }: { rows: ReconcileRow[] }) {
  return (
    <ul className="divide-y divide-border text-sm">
      {rows.map((r) => (
        <li key={r.orderNumber} className="flex items-center justify-between gap-3 py-1.5">
          <span className="flex items-center gap-2">
            <span className="font-medium">{r.orderNumber}</span>
            {r.note ? (
              <span className="text-xs text-muted-foreground">{r.note}</span>
            ) : null}
          </span>
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            {r.channel ? <span>{r.channel}</span> : null}
            {r.ageMinutes != null ? (
              <span className="tabular-nums">{ageLabel(r.ageMinutes)}</span>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  )
}

const TONE: Record<string, string> = {
  alert: "text-destructive",
  warn: "text-amber-600",
  muted: "text-muted-foreground",
}

function Section({
  title,
  blurb,
  rows,
  tone,
}: {
  title: string
  blurb: string
  rows: ReconcileRow[]
  tone: "alert" | "warn" | "muted"
}) {
  if (rows.length === 0) return null
  return (
    <Card>
      <CardHeader>
        <CardTitle className={`text-base ${TONE[tone]}`}>
          {title} ({rows.length})
        </CardTitle>
        <p className="text-sm text-muted-foreground">{blurb}</p>
      </CardHeader>
      <CardContent>
        <RowList rows={rows} />
      </CardContent>
    </Card>
  )
}

export function ReconcileView({ configured }: { configured: boolean }) {
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<ReconcileResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  function run() {
    setError(null)
    startTransition(async () => {
      const res = await runShipStationReconcile()
      if (res.ok) setResult(res.result)
      else setError(res.error)
    })
  }

  if (!configured) {
    return (
      <Card>
        <CardContent className="py-8 text-sm text-muted-foreground">
          ShipStation isn&apos;t connected yet. Add{" "}
          <code className="rounded bg-muted px-1">SHIPSTATION_API_KEY</code> and{" "}
          <code className="rounded bg-muted px-1">SHIPSTATION_API_SECRET</code> to
          the environment (ShipStation → Settings → Account → API Settings → API
          Keys), then reload this page.
        </CardContent>
      </Card>
    )
  }

  const problemCount = result
    ? result.missing.length +
      result.extra.length +
      result.shippedNotFulfilled.length +
      result.cancelledButAwaiting.length +
      result.qtyMismatch.length +
      result.addressMismatch.length +
      result.ssHoldingButOtReady.length +
      result.duplicateImports.length
    : 0

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <Button onClick={run} disabled={pending}>
          <RefreshCw
            className={pending ? "size-4 animate-spin" : "size-4"}
            data-icon="inline-start"
          />
          {pending ? "Checking…" : "Run alignment check"}
        </Button>
        {result ? (
          <span className="text-xs text-muted-foreground">
            Last run {formatDateTime(result.ranAt)}
          </span>
        ) : null}
      </div>

      {error ? (
        <Card>
          <CardContent className="py-4 text-sm text-destructive">{error}</CardContent>
        </Card>
      ) : null}

      {result ? (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="OT ready to ship" value={result.otReady} />
            <Stat label="ShipStation awaiting" value={result.ssAwaiting} />
            <Stat label="Matched" value={result.matched} />
            <Stat label="Needs attention" value={problemCount} highlight={problemCount > 0} />
          </div>

          {problemCount === 0 ? (
            <Card>
              <CardContent className="flex items-center gap-2 py-4 text-sm text-emerald-700 dark:text-emerald-300">
                <CheckCircle2 className="size-4" />
                Aligned — no discrepancies. {result.syncing.length > 0
                  ? `${result.syncing.length} order(s) may still be syncing (below).`
                  : ""}
              </CardContent>
            </Card>
          ) : null}

          {/* Tier 1 — can cause a wrong shipment */}
          <Section
            tone="alert"
            title="Shipped in ShipStation, still to-pack in OT"
            blurb="ShipStation shipped these but OT still shows them created/picking/packed. Risk of double-packing and count drift — mark them fulfilled in OT."
            rows={result.shippedNotFulfilled}
          />
          <Section
            tone="alert"
            title="Cancelled in OT, still Awaiting in ShipStation"
            blurb="Cancelled on the OT/store side but ShipStation is about to ship them. Cancel them in ShipStation."
            rows={result.cancelledButAwaiting}
          />
          <Section
            tone="alert"
            title="In ShipStation, not in OT"
            blurb="ShipStation is working these but OT is holding or hiding them — investigate (e.g. wrongly held for payment)."
            rows={result.extra}
          />

          {/* Tier 2 — data drift */}
          <Section
            tone="warn"
            title="Quantity mismatch"
            blurb="Same order, different unit totals between OT and ShipStation — usually an item added/removed in the store after import."
            rows={result.qtyMismatch}
          />
          <Section
            tone="warn"
            title="Ship-to postal mismatch"
            blurb="Ship-to postal code differs between OT and ShipStation — an address edit could send the parcel to the wrong place."
            rows={result.addressMismatch}
          />

          {/* Tier 3 — hygiene */}
          <Section
            tone="warn"
            title="ShipStation holding, OT ready"
            blurb="ShipStation has these on hold / awaiting payment but OT thinks they're ready — OT may have let an unpaid order through."
            rows={result.ssHoldingButOtReady}
          />
          <Section
            tone="warn"
            title="In OT, not in ShipStation"
            blurb={`Older than ${result.graceMinutes}m — ShipStation should have these by now. Check the store connection / re-sync in ShipStation.`}
            rows={result.missing}
          />
          <Section
            tone="warn"
            title="Duplicate imports"
            blurb="One store order mapped to more than one OT order — likely a re-import; merge or cancel the extras."
            rows={result.duplicateImports}
          />
          <Section
            tone="muted"
            title={`Aging (ready > ${result.agingDays}d)`}
            blurb="Ready to ship but sitting for a while — worth a look even though both systems agree."
            rows={result.aging}
          />

          {/* Benign */}
          <Section
            tone="muted"
            title="Probably still syncing"
            blurb={`Created in the last ${result.graceMinutes}m — ShipStation likely just hasn't pulled them yet. Usually clears on its own.`}
            rows={result.syncing}
          />
        </>
      ) : (
        <Card>
          <CardContent className="py-8 text-sm text-muted-foreground">
            Run the check to compare OT&apos;s ready-to-ship orders against
            ShipStation across awaiting, shipped, on-hold and awaiting-payment.
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function Stat({
  label,
  value,
  highlight,
}: {
  label: string
  value: number
  highlight?: boolean
}) {
  return (
    <Card>
      <CardContent className="py-4">
        <div
          className={
            highlight
              ? "text-2xl font-semibold tabular-nums text-amber-600"
              : "text-2xl font-semibold tabular-nums"
          }
        >
          {value}
        </div>
        <div className="text-xs text-muted-foreground">{label}</div>
      </CardContent>
    </Card>
  )
}
