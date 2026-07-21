"use client"

import { useState, useTransition } from "react"
import { RefreshCw, CheckCircle2 } from "lucide-react"

import Link from "next/link"

import { Button, buttonVariants } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import { formatDateTime } from "@/lib/format"
import { runShipStationReconcile } from "./actions"
import type { ReconcileResult, ReconcileRow } from "@/lib/shipstation/reconcile"

function graceText(m: number): string {
  return m % 60 === 0 ? `${m / 60}h` : `${m}m`
}

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
  packingLink,
}: {
  title: string
  blurb: string
  rows: ReconcileRow[]
  tone: "alert" | "warn" | "muted"
  /** Show a link to the packing screen (for orders the team should pack in OT). */
  packingLink?: boolean
}) {
  if (rows.length === 0) return null
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <CardTitle className={`text-base ${TONE[tone]}`}>
            {title} ({rows.length})
          </CardTitle>
          {packingLink ? (
            <Link
              href="/packing"
              className={cn(buttonVariants({ size: "sm" }), "shrink-0")}
            >
              Go to packing screen
            </Link>
          ) : null}
        </div>
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
  // Empty = no floor (show all). Blank until the first run, which prefills it
  // from the store's go-live cutoff (sync_orders_since).
  const [ignoreBefore, setIgnoreBefore] = useState("")
  const [hasRun, setHasRun] = useState(false)

  function run() {
    setError(null)
    startTransition(async () => {
      // First run: let the server default the floor to the launch cutoff.
      // After that: send the (possibly edited or cleared) date the user chose.
      const res = await runShipStationReconcile(
        hasRun ? { ignoreBefore: ignoreBefore || "" } : undefined,
      )
      if (res.ok) {
        setResult(res.result)
        if (!hasRun) {
          setIgnoreBefore(res.result.ignoreBefore?.slice(0, 10) ?? "")
        }
        setHasRun(true)
      } else setError(res.error)
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
      result.shippedNotInOt.length +
      result.shippedNotFulfilled.length +
      result.cancelledButAwaiting.length +
      result.qtyMismatch.length +
      result.addressMismatch.length +
      result.ssHoldingButOtReady.length +
      result.duplicateImports.length
    : 0

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={run} disabled={pending}>
          <RefreshCw
            className={pending ? "size-4 animate-spin" : "size-4"}
            data-icon="inline-start"
          />
          {pending ? "Checking…" : "Run alignment check"}
        </Button>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          Ignore orders before
          <input
            type="date"
            value={ignoreBefore}
            onChange={(e) => setIgnoreBefore(e.target.value)}
            className="rounded border border-input bg-background px-2 py-1 text-xs text-foreground"
          />
          {ignoreBefore ? (
            <button
              type="button"
              onClick={() => setIgnoreBefore("")}
              className="underline hover:text-foreground"
            >
              clear
            </button>
          ) : null}
          {hasRun ? <span>— re-run to apply</span> : null}
        </label>
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

          <p className="text-xs text-muted-foreground">
            {result.ignoreBefore
              ? `Ignoring ShipStation orders placed before ${formatDateTime(result.ignoreBefore)} (pre-launch orders OT never imported). Clear the date above and re-run to include them.`
              : "Showing all orders — no date floor. Set “Ignore orders before” above to hide pre-launch orders."}
          </p>

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
            title="Shipped in ShipStation, missing from OT"
            blurb="ShipStation shipped these but OT has no matching order at all — they were never imported, so OT can't count or bill them. This is the usual cause of 'ShipStation shipped more than WMS shows'. Check the store→OT sync for these order numbers."
            rows={result.shippedNotInOt}
          />
          <Section
            tone="alert"
            title="Shipped in ShipStation, not fulfilled in OT"
            blurb="ShipStation shipped these but OT hasn't recorded the ship — the note shows OT's current status (still to-pack, held, or cancelled). Pack/close them in OT to capture packaging and close the order; a cancelled one that shipped needs a second look."
            rows={result.shippedNotFulfilled}
            packingLink
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
            blurb={`Older than ${graceText(result.graceMinutes)} — ShipStation should have these by now. Check the store connection / re-sync in ShipStation.`}
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
            blurb={`Created in the last ${graceText(result.graceMinutes)} — ShipStation likely just hasn't pulled them yet. Usually clears on its own.`}
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
