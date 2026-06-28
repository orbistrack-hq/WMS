"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { AlertCircle, ArrowRight, Plus, Trash2, Truck, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { formatCurrency } from "@/lib/format"
import {
  CARRIERS,
  NEXT_SHIPMENT_STATUS,
  SHIPMENT_STATUS_BADGE,
  formatWeight,
  summarizeShipping,
  type PackageRow,
  type ShipmentRow,
} from "@/lib/shipping/types"
import {
  addPackage,
  createShipment,
  removePackage,
  removeShipment,
  setShipmentStatus,
  updatePackage,
  updateShipment,
} from "../actions"

type ActionFn = () => Promise<{ ok: boolean; error?: string }>

export function ShippingEditor({
  groupId,
  shipments,
}: {
  groupId: string
  shipments: ShipmentRow[]
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  // New-shipment form.
  const [newCarrier, setNewCarrier] = useState("")
  const [newService, setNewService] = useState("")
  const [newEstimated, setNewEstimated] = useState("")

  function run(fn: ActionFn) {
    setError(null)
    startTransition(async () => {
      const res = await fn()
      if (!res.ok) setError(res.error ?? "Something went wrong.")
      else router.refresh()
    })
  }

  function addShipment() {
    run(async () => {
      const res = await createShipment(groupId, {
        carrier: newCarrier,
        serviceLevel: newService,
        estimatedCost: newEstimated,
      })
      if (res.ok) {
        setNewCarrier("")
        setNewService("")
        setNewEstimated("")
      }
      return res
    })
  }

  const totals = summarizeShipping(shipments)

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground">
        Shipping is recorded per fulfillment group and is independent of
        fulfillment — marking a shipment shipped does not consume inventory or
        close the order. A group can have multiple shipments, each with multiple
        packages.
      </p>

      {error ? (
        <div className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      <datalist id="carrier-options">
        {CARRIERS.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>

      {shipments.length > 0 ? (
        <div className="flex flex-col gap-3">
          {shipments.map((s) => (
            <ShipmentCard
              key={s.id}
              groupId={groupId}
              shipment={s}
              isPending={isPending}
              run={run}
            />
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No shipments yet.</p>
      )}

      {/* New shipment */}
      <div className="flex flex-wrap items-end gap-2 rounded-lg border border-border p-3">
        <div className="flex min-w-32 flex-1 flex-col gap-1">
          <Label className="text-xs">Carrier</Label>
          <Input
            list="carrier-options"
            placeholder="USPS, UPS…"
            value={newCarrier}
            onChange={(e) => setNewCarrier(e.target.value)}
          />
        </div>
        <div className="flex min-w-32 flex-1 flex-col gap-1">
          <Label className="text-xs">Service level</Label>
          <Input
            placeholder="Ground, Priority…"
            value={newService}
            onChange={(e) => setNewService(e.target.value)}
          />
        </div>
        <div className="flex w-28 flex-col gap-1">
          <Label className="text-xs">Est. cost</Label>
          <Input
            type="number"
            min="0"
            step="0.01"
            placeholder="0.00"
            value={newEstimated}
            onChange={(e) => setNewEstimated(e.target.value)}
          />
        </div>
        <Button onClick={addShipment} disabled={isPending}>
          <Truck data-icon="inline-start" /> Add shipment
        </Button>
      </div>

      <div className="flex flex-col gap-1 border-t pt-2 text-sm">
        <div className="flex justify-between">
          <span className="text-muted-foreground">Estimated</span>
          <span className="tabular-nums">{formatCurrency(totals.estimated)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Actual</span>
          <span className="tabular-nums">{formatCurrency(totals.actual)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">
            Packages ({totals.packageCount})
          </span>
          <span className="tabular-nums">
            {formatCurrency(totals.packageCost)} ·{" "}
            {formatWeight(totals.weightGrams)}
          </span>
        </div>
      </div>
    </div>
  )
}

const numStr = (v: number | null) => (v === null ? "" : String(v))

function ShipmentCard({
  groupId,
  shipment,
  isPending,
  run,
}: {
  groupId: string
  shipment: ShipmentRow
  isPending: boolean
  run: (fn: ActionFn) => void
}) {
  const [carrier, setCarrier] = useState(shipment.carrier ?? "")
  const [service, setService] = useState(shipment.service_level ?? "")
  const [estimated, setEstimated] = useState(numStr(shipment.estimated_cost))
  const [actual, setActual] = useState(numStr(shipment.actual_cost))

  const badge = SHIPMENT_STATUS_BADGE[shipment.status]
  const next = NEXT_SHIPMENT_STATUS[shipment.status]
  const cancelled = shipment.status === "cancelled"

  function commit() {
    run(() =>
      updateShipment(shipment.id, groupId, {
        carrier,
        serviceLevel: service,
        estimatedCost: estimated,
        actualCost: actual,
      }),
    )
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <Badge variant={badge.variant}>{badge.label}</Badge>
        <div className="flex items-center gap-1.5">
          {next ? (
            <Button
              size="sm"
              variant="outline"
              disabled={isPending}
              onClick={() =>
                run(() => setShipmentStatus(shipment.id, groupId, next))
              }
            >
              Mark {SHIPMENT_STATUS_BADGE[next].label.toLowerCase()}
              <ArrowRight data-icon="inline-end" />
            </Button>
          ) : null}
          {!cancelled ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={isPending}
              onClick={() =>
                run(() => setShipmentStatus(shipment.id, groupId, "cancelled"))
              }
            >
              <X data-icon="inline-start" /> Cancel
            </Button>
          ) : null}
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Delete shipment"
            disabled={isPending}
            onClick={() => run(() => removeShipment(shipment.id, groupId))}
          >
            <Trash2 />
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="flex flex-col gap-1">
          <Label className="text-xs">Carrier</Label>
          <Input
            list="carrier-options"
            value={carrier}
            disabled={isPending || cancelled}
            onChange={(e) => setCarrier(e.target.value)}
            onBlur={commit}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label className="text-xs">Service</Label>
          <Input
            value={service}
            disabled={isPending || cancelled}
            onChange={(e) => setService(e.target.value)}
            onBlur={commit}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label className="text-xs">Est. cost</Label>
          <Input
            type="number"
            min="0"
            step="0.01"
            value={estimated}
            disabled={isPending || cancelled}
            onChange={(e) => setEstimated(e.target.value)}
            onBlur={commit}
            className="text-right"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label className="text-xs">Actual cost</Label>
          <Input
            type="number"
            min="0"
            step="0.01"
            value={actual}
            disabled={isPending || cancelled}
            onChange={(e) => setActual(e.target.value)}
            onBlur={commit}
            className="text-right"
          />
        </div>
      </div>

      <PackagesTable
        groupId={groupId}
        shipmentId={shipment.id}
        packages={shipment.packages}
        isPending={isPending}
        disabled={cancelled}
        run={run}
      />
    </div>
  )
}

function PackagesTable({
  groupId,
  shipmentId,
  packages,
  isPending,
  disabled,
  run,
}: {
  groupId: string
  shipmentId: string
  packages: PackageRow[]
  isPending: boolean
  disabled: boolean
  run: (fn: ActionFn) => void
}) {
  const [tracking, setTracking] = useState("")
  const [cost, setCost] = useState("")
  const [weight, setWeight] = useState("")

  function add() {
    run(async () => {
      const res = await addPackage(shipmentId, groupId, {
        trackingNumber: tracking,
        cost,
        weightGrams: weight,
      })
      if (res.ok) {
        setTracking("")
        setCost("")
        setWeight("")
      }
      return res
    })
  }

  return (
    <div className="flex flex-col gap-2">
      {packages.length > 0 ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Tracking #</TableHead>
              <TableHead className="text-right">Cost</TableHead>
              <TableHead className="text-right">Weight (g)</TableHead>
              <TableHead className="w-px" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {packages.map((p) => (
              <PackageRowEditor
                key={p.id}
                groupId={groupId}
                pkg={p}
                isPending={isPending}
                disabled={disabled}
                run={run}
              />
            ))}
          </TableBody>
        </Table>
      ) : (
        <p className="text-xs text-muted-foreground">No packages on this shipment.</p>
      )}

      {!disabled ? (
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex min-w-40 flex-1 flex-col gap-1">
            <Label className="text-xs">Tracking #</Label>
            <Input
              value={tracking}
              onChange={(e) => setTracking(e.target.value)}
            />
          </div>
          <div className="flex w-24 flex-col gap-1">
            <Label className="text-xs">Cost</Label>
            <Input
              type="number"
              min="0"
              step="0.01"
              placeholder="0.00"
              value={cost}
              onChange={(e) => setCost(e.target.value)}
            />
          </div>
          <div className="flex w-24 flex-col gap-1">
            <Label className="text-xs">Weight (g)</Label>
            <Input
              type="number"
              min="0"
              step="1"
              value={weight}
              onChange={(e) => setWeight(e.target.value)}
            />
          </div>
          <Button size="sm" variant="outline" onClick={add} disabled={isPending}>
            <Plus data-icon="inline-start" /> Package
          </Button>
        </div>
      ) : null}
    </div>
  )
}

function PackageRowEditor({
  groupId,
  pkg,
  isPending,
  disabled,
  run,
}: {
  groupId: string
  pkg: PackageRow
  isPending: boolean
  disabled: boolean
  run: (fn: ActionFn) => void
}) {
  const [tracking, setTracking] = useState(pkg.tracking_number ?? "")
  const [cost, setCost] = useState(numStr(pkg.cost))
  const [weight, setWeight] = useState(numStr(pkg.weight_grams))

  function commit() {
    run(() =>
      updatePackage(pkg.id, groupId, {
        trackingNumber: tracking,
        cost,
        weightGrams: weight,
      }),
    )
  }

  return (
    <TableRow>
      <TableCell>
        <Input
          value={tracking}
          disabled={isPending || disabled}
          onChange={(e) => setTracking(e.target.value)}
          onBlur={commit}
          className="min-w-36"
        />
      </TableCell>
      <TableCell className="text-right">
        <Input
          type="number"
          min="0"
          step="0.01"
          value={cost}
          disabled={isPending || disabled}
          onChange={(e) => setCost(e.target.value)}
          onBlur={commit}
          className="ml-auto w-20 text-right"
        />
      </TableCell>
      <TableCell className="text-right">
        <Input
          type="number"
          min="0"
          step="1"
          value={weight}
          disabled={isPending || disabled}
          onChange={(e) => setWeight(e.target.value)}
          onBlur={commit}
          className="ml-auto w-20 text-right"
        />
      </TableCell>
      <TableCell>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Remove package"
          disabled={isPending}
          onClick={() => run(() => removePackage(pkg.id, groupId))}
        >
          <Trash2 />
        </Button>
      </TableCell>
    </TableRow>
  )
}
