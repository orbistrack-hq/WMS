"use client"

import { useMemo, useState, useTransition } from "react"
import Link from "next/link"
import { AlertCircle, ArrowLeft, Check, PackageCheck } from "lucide-react"

import { Button, buttonVariants } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { Combobox } from "@/components/ui/combobox"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import {
  receiveIntake,
  loadAllocationTargets,
  saveAllocation,
  getAllocationSyncStatus,
  type AllocationClient,
  type AllocationResult,
  type SyncStatus,
  type SyncStatusRow,
} from "./actions"

const SYNC_META: Record<
  SyncStatus,
  { label: string; variant: "success" | "info" | "warning" | "destructive" | "muted" | "outline" }
> = {
  done: { label: "Synced", variant: "success" },
  processing: { label: "Syncing", variant: "info" },
  pending: { label: "Queued", variant: "info" },
  failed: { label: "Failed", variant: "destructive" },
  skipped: { label: "Skipped", variant: "muted" },
  off: { label: "Store sync off", variant: "muted" },
  unmapped: { label: "No store mapping", variant: "outline" },
}

type Site = { id: string; name: string }
type Product = { id: string; name: string }

const UOM_OPTIONS = ["lb", "oz", "g", "kg"]
// Operational convention (matches the to_grams DB helper): 1 oz = 28 g, 1 lb = 448 g.
const UOM_TO_G: Record<string, number> = { g: 1, oz: 28, lb: 448, kg: 1000 }

function toGrams(qty: number, uom: string): number {
  const q = Number.isFinite(qty) ? qty : 0
  return q * (UOM_TO_G[uom] ?? 0)
}
function fmtGrams(n: number): string {
  const v = Math.round(n * 100) / 100
  return `${Number.isInteger(v) ? v : v.toFixed(1)}g`
}

type Step = "select" | "receive" | "allocate" | "done"

const STEPS: { key: Step; label: string }[] = [
  { key: "select", label: "Select" },
  { key: "receive", label: "Receive" },
  { key: "allocate", label: "Allocate" },
  { key: "done", label: "Done" },
]

export function IntakeFlow({
  products,
  sites,
}: {
  products: Product[]
  sites: Site[]
}) {
  const [step, setStep] = useState<Step>("select")
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  // Step 1 fields
  const [productId, setProductId] = useState("")
  const [siteId, setSiteId] = useState(sites[0]?.id ?? "")
  const [qty, setQty] = useState("")
  const [uom, setUom] = useState("lb")
  const [batchNo, setBatchNo] = useState("")
  const [intakeNote, setIntakeNote] = useState("")

  const productName = products.find((p) => p.id === productId)?.name ?? ""
  const siteName = sites.find((s) => s.id === siteId)?.name ?? ""

  // Carried forward
  const [receivedGrams, setReceivedGrams] = useState(0)
  const [poolAvailable, setPoolAvailable] = useState(0)

  // Step 3
  const [clients, setClients] = useState<AllocationClient[]>([])
  const [units, setUnits] = useState<Record<string, string>>({})
  const [idemKey, setIdemKey] = useState("")
  const [allocNote, setAllocNote] = useState("")

  // Step 4
  const [result, setResult] = useState<AllocationResult | null>(null)
  const [syncRows, setSyncRows] = useState<SyncStatusRow[] | null>(null)
  const [syncLoading, setSyncLoading] = useState(false)

  function loadSync(allocationId: string) {
    setSyncLoading(true)
    getAllocationSyncStatus(allocationId)
      .then((res) => {
        if (res.ok) setSyncRows(res.rows)
      })
      .finally(() => setSyncLoading(false))
  }

  const previewGrams = toGrams(Number(qty), uom)
  const productOptions = useMemo(
    () => products.map((p) => ({ value: p.id, label: p.name })),
    [products],
  )

  const allocatedGrams = useMemo(() => {
    let sum = 0
    for (const c of clients)
      for (const ch of c.children)
        sum += (parseInt(units[ch.id] || "0", 10) || 0) * ch.gramsPerUnit
    return sum
  }, [clients, units])
  const remaining = poolAvailable - allocatedGrams
  const isOver = allocatedGrams > poolAvailable
  const nearly = !isOver && poolAvailable > 0 && remaining <= poolAvailable * 0.1
  const tone: "ok" | "nearly" | "over" = isOver
    ? "over"
    : nearly
      ? "nearly"
      : "ok"

  // ---- handlers ----
  function doReceive() {
    setError(null)
    const q = Number(qty)
    if (!productId) return setError("Pick a parent SKU.")
    if (!siteId) return setError("Pick a receiving site.")
    if (!(q > 0)) return setError("Enter a quantity greater than zero.")
    startTransition(async () => {
      const res = await receiveIntake({
        productId,
        siteId,
        qty: q,
        uom,
        batchNo,
        note: intakeNote,
      })
      if (!res.ok) return setError(res.error)
      setReceivedGrams(res.receivedGrams)
      setPoolAvailable(res.onHandGrams)
      setStep("receive")
    })
  }

  function doLoadAllocation() {
    setError(null)
    startTransition(async () => {
      const res = await loadAllocationTargets(productId, siteId)
      if (!res.ok) return setError(res.error)
      setClients(res.clients)
      setPoolAvailable(res.parentAvailableGrams)
      setUnits({})
      setIdemKey(crypto.randomUUID())
      setStep("allocate")
    })
  }

  function doSave() {
    setError(null)
    if (isOver)
      return setError(
        "Total allocated inventory exceeds available Parent SKU inventory.",
      )
    const lines = Object.entries(units)
      .map(([child_sku_id, u]) => ({
        child_sku_id,
        units: parseInt(u || "0", 10) || 0,
      }))
      .filter((l) => l.units > 0)
    if (lines.length === 0)
      return setError("Enter at least one quantity to allocate.")
    startTransition(async () => {
      const res = await saveAllocation({
        productId,
        poolSiteId: siteId,
        lines,
        idempotencyKey: idemKey,
        note: allocNote,
      })
      if (!res.ok) return setError(res.error)
      setResult(res.result)
      setSyncRows(null)
      loadSync(res.result.allocation_id)
      setStep("done")
    })
  }

  function reset() {
    setStep("select")
    setError(null)
    setProductId("")
    setQty("")
    setBatchNo("")
    setIntakeNote("")
    setReceivedGrams(0)
    setPoolAvailable(0)
    setClients([])
    setUnits({})
    setResult(null)
    setAllocNote("")
  }

  const toneClasses: Record<typeof tone, string> = {
    ok: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
    nearly:
      "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
    over: "border-destructive/40 bg-destructive/10 text-destructive",
  }

  const currentIndex = STEPS.findIndex((s) => s.key === step)

  return (
    <div className="flex flex-col gap-4">
      {/* Stepper */}
      <ol className="flex flex-wrap items-center gap-2 text-sm">
        {STEPS.map((s, i) => (
          <li key={s.key} className="flex items-center gap-2">
            <span
              className={cn(
                "flex size-6 items-center justify-center rounded-full text-xs font-medium",
                i < currentIndex
                  ? "bg-primary text-primary-foreground"
                  : i === currentIndex
                    ? "bg-primary/15 text-primary ring-1 ring-primary"
                    : "bg-muted text-muted-foreground",
              )}
            >
              {i < currentIndex ? <Check className="size-3.5" /> : i + 1}
            </span>
            <span
              className={cn(
                i === currentIndex
                  ? "font-medium text-foreground"
                  : "text-muted-foreground",
              )}
            >
              {s.label}
            </span>
            {i < STEPS.length - 1 ? (
              <span className="mx-1 text-muted-foreground/40">→</span>
            ) : null}
          </li>
        ))}
      </ol>

      {error ? (
        <div className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      {/* ---- Step 1: Select parent + receive ---- */}
      {step === "select" ? (
        <Card>
          <CardHeader>
            <CardTitle>Select parent SKU</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label>Parent SKU</Label>
                <Combobox
                  value={productId}
                  onValueChange={setProductId}
                  options={productOptions}
                  placeholder="Choose a product / strain…"
                  searchPlaceholder="Search products…"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="site">Receiving site</Label>
                <Select
                  id="site"
                  value={siteId}
                  onChange={(e) => setSiteId(e.target.value)}
                >
                  {sites.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="qty">Quantity received</Label>
                <Input
                  id="qty"
                  type="number"
                  step="0.01"
                  min="0"
                  value={qty}
                  onChange={(e) => setQty(e.target.value)}
                  placeholder="e.g. 1"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="uom">Unit</Label>
                <Select
                  id="uom"
                  value={uom}
                  onChange={(e) => setUom(e.target.value)}
                >
                  {UOM_OPTIONS.map((u) => (
                    <option key={u} value={u}>
                      {u}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="batch">Batch / lot (optional)</Label>
                <Input
                  id="batch"
                  value={batchNo}
                  onChange={(e) => setBatchNo(e.target.value)}
                  placeholder="optional"
                />
              </div>
            </div>

            {previewGrams > 0 ? (
              <p className="text-sm text-muted-foreground">
                Receives{" "}
                <span className="font-medium text-foreground">
                  {fmtGrams(previewGrams)}
                </span>{" "}
                into the {siteName || "site"} pool.
              </p>
            ) : null}

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="inote">Note (optional)</Label>
              <Textarea
                id="inote"
                value={intakeNote}
                onChange={(e) => setIntakeNote(e.target.value)}
                rows={2}
                placeholder="Anything worth recording about this receipt…"
              />
            </div>

            <div className="flex items-center gap-2">
              <Button onClick={doReceive} disabled={isPending}>
                Continue
              </Button>
              <Link
                href="/inventory"
                className={buttonVariants({ variant: "ghost" })}
              >
                Cancel
              </Link>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* ---- Step 2: Receive confirmation ---- */}
      {step === "receive" ? (
        <Card>
          <CardHeader>
            <CardTitle>Intake successful</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">
              Received{" "}
              <span className="font-medium text-foreground">
                {fmtGrams(receivedGrams)}
              </span>{" "}
              of <span className="font-medium text-foreground">{productName}</span>{" "}
              at {siteName}.
            </p>
            <div className="rounded-lg border border-border p-4">
              <p className="text-xs text-muted-foreground">
                Parent inventory available
              </p>
              <p className="text-3xl font-semibold tabular-nums">
                {fmtGrams(poolAvailable)}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button onClick={doLoadAllocation} disabled={isPending}>
                Allocate inventory
              </Button>
              <Button variant="ghost" onClick={reset} disabled={isPending}>
                Done for now
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* ---- Step 3: Allocation ---- */}
      {step === "allocate" ? (
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="flex flex-col gap-4 lg:col-span-2">
            {clients.length === 0 ? (
              <Card>
                <CardContent className="flex flex-col items-center gap-3 py-8 text-center">
                  <p className="max-w-md text-sm text-muted-foreground">
                    {productName} has no weight-variant child SKUs yet, so
                    there&apos;s nothing to allocate. If this strain was imported
                    as separate per-weight products, group them into weight
                    variants first.
                  </p>
                  <div className="flex flex-wrap justify-center gap-2">
                    <Link
                      href="/catalog/backfill"
                      className={buttonVariants()}
                    >
                      Group weights
                    </Link>
                    <Link
                      href="/catalog"
                      className={buttonVariants({ variant: "outline" })}
                    >
                      Open catalog
                    </Link>
                  </div>
                </CardContent>
              </Card>
            ) : (
              clients.map((c) => {
                const subtotal = c.children.reduce(
                  (sum, ch) =>
                    sum + (parseInt(units[ch.id] || "0", 10) || 0) * ch.gramsPerUnit,
                  0,
                )
                return (
                  <Card key={c.siteId}>
                    <CardHeader className="flex-row items-center justify-between">
                      <CardTitle>{c.siteName}</CardTitle>
                      <span className="text-sm text-muted-foreground tabular-nums">
                        {fmtGrams(subtotal)}
                      </span>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-2">
                      {c.children.map((ch) => {
                        const u = parseInt(units[ch.id] || "0", 10) || 0
                        return (
                          <div
                            key={ch.id}
                            className="flex items-center justify-between gap-3"
                          >
                            <div className="flex flex-col">
                              <span className="text-sm font-medium">
                                {ch.label}
                              </span>
                              <span className="text-xs text-muted-foreground">
                                {ch.gramsPerUnit}g each · {ch.available} on hand
                              </span>
                            </div>
                            <Input
                              type="number"
                              min="0"
                              step="1"
                              inputMode="numeric"
                              aria-label={`${c.siteName} ${ch.label} units`}
                              aria-invalid={isOver && u > 0}
                              value={units[ch.id] ?? ""}
                              onChange={(e) =>
                                setUnits((prev) => ({
                                  ...prev,
                                  [ch.id]: e.target.value,
                                }))
                              }
                              className="w-24 text-right tabular-nums"
                              placeholder="0"
                            />
                          </div>
                        )
                      })}
                    </CardContent>
                  </Card>
                )
              })
            )}
          </div>

          {/* Live summary panel */}
          <div className="lg:col-span-1">
            <Card className="lg:sticky lg:top-4">
              <CardHeader>
                <CardTitle>Allocation summary</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Parent inventory</span>
                  <span className="font-medium tabular-nums">
                    {fmtGrams(poolAvailable)}
                  </span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Allocated</span>
                  <span className="font-medium tabular-nums">
                    {fmtGrams(allocatedGrams)}
                  </span>
                </div>
                <div
                  className={cn(
                    "flex items-center justify-between rounded-lg border px-3 py-2 text-sm",
                    toneClasses[tone],
                  )}
                >
                  <span>Remaining</span>
                  <span className="font-semibold tabular-nums">
                    {fmtGrams(remaining)}
                  </span>
                </div>
                {isOver ? (
                  <p className="text-xs text-destructive">
                    Total allocated inventory exceeds available Parent SKU
                    inventory.
                  </p>
                ) : nearly ? (
                  <p className="text-xs text-amber-600 dark:text-amber-400">
                    Parent inventory nearly exhausted.
                  </p>
                ) : null}

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="anote">Note (optional)</Label>
                  <Textarea
                    id="anote"
                    value={allocNote}
                    onChange={(e) => setAllocNote(e.target.value)}
                    rows={2}
                  />
                </div>

                <Button
                  onClick={doSave}
                  disabled={isPending || isOver || allocatedGrams <= 0}
                >
                  Save allocation
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => setStep("receive")}
                  disabled={isPending}
                >
                  <ArrowLeft data-icon="inline-start" /> Back
                </Button>
              </CardContent>
            </Card>
          </div>
        </div>
      ) : null}

      {/* ---- Step 4: Completion ---- */}
      {step === "done" && result ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <PackageCheck className="size-5 text-emerald-600 dark:text-emerald-400" />
              Intake complete
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <dl className="grid gap-3 sm:grid-cols-2">
              <Summary label="Parent SKU" value={productName} />
              <Summary label="Received" value={fmtGrams(receivedGrams)} />
              <Summary
                label="Total allocated"
                value={fmtGrams(result.total_grams)}
              />
              <Summary
                label="Remaining parent inventory"
                value={fmtGrams(result.remaining_grams)}
              />
              <Summary
                label="Client SKUs updated"
                value={String(result.child_count)}
              />
            </dl>

            {/* Website sync status per child SKU */}
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium">Website sync</h3>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => loadSync(result.allocation_id)}
                  disabled={syncLoading}
                >
                  {syncLoading ? "Refreshing…" : "Refresh"}
                </Button>
              </div>
              {syncRows === null ? (
                <p className="text-sm text-muted-foreground">
                  Loading sync status…
                </p>
              ) : syncRows.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No child SKUs to sync.
                </p>
              ) : (
                <ul className="divide-y divide-border rounded-lg border border-border">
                  {syncRows.map((r) => {
                    const meta = SYNC_META[r.status]
                    return (
                      <li
                        key={r.childId}
                        className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                      >
                        <span>
                          <span className="font-medium">{r.siteName}</span>{" "}
                          <span className="text-muted-foreground">
                            · {r.label} × {r.units}
                          </span>
                        </span>
                        <Badge
                          variant={meta.variant}
                          title={r.detail ?? undefined}
                        >
                          {meta.label}
                        </Badge>
                      </li>
                    )
                  })}
                </ul>
              )}
              <p className="text-xs text-muted-foreground">
                Pushes run in the background — refresh to see them complete.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Link href="/inventory" className={buttonVariants()}>
                Return to inventory
              </Link>
              <Link
                href="/inventory/intake/history"
                className={buttonVariants({ variant: "outline" })}
              >
                View allocation history
              </Link>
              <Button variant="ghost" onClick={reset}>
                Start another intake
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  )
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-medium">{value}</dd>
    </div>
  )
}
