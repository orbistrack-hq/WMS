// TODO turn all dropdowns into searchable selects, so that users can type to filter options instead of scrolling through long lists.
"use client"

import { useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { AlertCircle, Plus, Trash2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { ORDER_TYPES, ORDER_TYPE_LABEL } from "@/lib/orders/types"
import { formatCurrency, todayISODate } from "@/lib/format"
import { createOrder, type CreateOrderInput } from "../actions"

export type SkuOption = {
  id: string
  site_id: string
  product_name: string
  sku: string | null
  price: number
  available: number
}

type SiteOption = { id: string; name: string }
type CustomerOption = { id: string; name: string | null }

type Line = {
  key: string
  child_sku_id: string
  quantity: string
  unit_price: string
}

let keyCounter = 0
const newKey = () => `line-${keyCounter++}`

export function OrderForm({
  sites,
  customers,
  skus,
}: {
  sites: SiteOption[]
  customers: CustomerOption[]
  skus: SkuOption[]
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const [siteId, setSiteId] = useState(sites[0]?.id ?? "")
  const [customerId, setCustomerId] = useState("")
  const [orderType, setOrderType] = useState<"standard" | "layaway">("standard")
  const [saleDate, setSaleDate] = useState(todayISODate())
  const [notes, setNotes] = useState("")

  // Ship-to (optional)
  const [shipName, setShipName] = useState("")
  const [shipAddr1, setShipAddr1] = useState("")
  const [shipAddr2, setShipAddr2] = useState("")
  const [shipCity, setShipCity] = useState("")
  const [shipRegion, setShipRegion] = useState("")
  const [shipPostal, setShipPostal] = useState("")
  const [shipCountry, setShipCountry] = useState("")

  const [lines, setLines] = useState<Line[]>([
    { key: newKey(), child_sku_id: "", quantity: "1", unit_price: "" },
  ])

  // Only SKUs at the chosen site can be ordered (inventory is per site).
  const siteSkus = useMemo(
    () => skus.filter((s) => s.site_id === siteId),
    [skus, siteId],
  )
  const skuById = useMemo(
    () => new Map(skus.map((s) => [s.id, s])),
    [skus],
  )

  function changeSite(next: string) {
    setSiteId(next)
    // SKUs are site-specific — reset lines that point elsewhere.
    setLines([
      { key: newKey(), child_sku_id: "", quantity: "1", unit_price: "" },
    ])
  }

  function updateLine(key: string, patch: Partial<Line>) {
    setLines((prev) =>
      prev.map((l) => (l.key === key ? { ...l, ...patch } : l)),
    )
  }

  function pickSku(key: string, skuId: string) {
    const sku = skuById.get(skuId)
    updateLine(key, {
      child_sku_id: skuId,
      unit_price: sku ? String(sku.price) : "",
    })
  }

  function addLine() {
    setLines((prev) => [
      ...prev,
      { key: newKey(), child_sku_id: "", quantity: "1", unit_price: "" },
    ])
  }

  function removeLine(key: string) {
    setLines((prev) =>
      prev.length === 1 ? prev : prev.filter((l) => l.key !== key),
    )
  }

  const orderTotal = lines.reduce((sum, l) => {
    const qty = Number(l.quantity)
    const price = Number(l.unit_price)
    if (!l.child_sku_id || !(qty > 0) || !Number.isFinite(price)) return sum
    return sum + qty * price
  }, 0)

  function submit() {
    setError(null)
    if (!siteId) {
      setError("Pick a site.")
      return
    }
    const validLines = lines.filter(
      (l) => l.child_sku_id && Number(l.quantity) > 0,
    )
    if (validLines.length === 0) {
      setError("Add at least one line item with a quantity.")
      return
    }
    // Warn (not block) on insufficient available stock; the DB is the gate.
    for (const l of validLines) {
      const sku = skuById.get(l.child_sku_id)
      if (sku && orderType === "standard" && Number(l.quantity) > sku.available) {
        setError(
          `Only ${sku.available} of ${sku.product_name} available — reduce the quantity.`,
        )
        return
      }
    }

    const input: CreateOrderInput = {
      site_id: siteId,
      customer_id: customerId || null,
      order_type: orderType,
      sale_date: saleDate || null,
      ship_to_name: shipName || null,
      ship_to_address1: shipAddr1 || null,
      ship_to_address2: shipAddr2 || null,
      ship_to_city: shipCity || null,
      ship_to_region: shipRegion || null,
      ship_to_postal: shipPostal || null,
      ship_to_country: shipCountry || null,
      notes: notes || null,
      lines: validLines.map((l) => ({
        child_sku_id: l.child_sku_id,
        quantity: Number(l.quantity),
        unit_price: l.unit_price === "" ? null : Number(l.unit_price),
      })),
    }

    startTransition(async () => {
      const res = await createOrder(input)
      if (!res.ok) setError(res.error)
      else router.push(`/orders/${res.orderId}`)
    })
  }

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="flex flex-col gap-4 lg:col-span-2">
        <Card>
          <CardHeader>
            <CardTitle>Line items</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {siteSkus.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No active SKUs at this site yet. Add them in the Catalog first.
              </p>
            ) : (
              lines.map((l) => {
                const sku = skuById.get(l.child_sku_id)
                return (
                  <div
                    key={l.key}
                    className="flex flex-wrap items-end gap-2 rounded-lg border border-border p-2.5"
                  >
                    <div className="flex min-w-48 flex-1 flex-col gap-1">
                      <Label className="text-xs">Product</Label>
                      <Select
                        value={l.child_sku_id}
                        onChange={(e) => pickSku(l.key, e.target.value)}
                      >
                        <option value="">Select a SKU…</option>
                        {siteSkus.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.product_name}
                            {s.sku ? ` (${s.sku})` : ""} — {s.available} avail
                          </option>
                        ))}
                      </Select>
                    </div>
                    <div className="flex w-20 flex-col gap-1">
                      <Label className="text-xs">Qty</Label>
                      <Input
                        type="number"
                        min="1"
                        step="1"
                        value={l.quantity}
                        onChange={(e) =>
                          updateLine(l.key, { quantity: e.target.value })
                        }
                      />
                    </div>
                    <div className="flex w-24 flex-col gap-1">
                      <Label className="text-xs">Unit price</Label>
                      <Input
                        type="number"
                        min="0"
                        step="0.01"
                        value={l.unit_price}
                        onChange={(e) =>
                          updateLine(l.key, { unit_price: e.target.value })
                        }
                      />
                    </div>
                    <div className="flex w-20 flex-col gap-1">
                      <Label className="text-xs">Line</Label>
                      <span className="flex h-8 items-center text-sm tabular-nums">
                        {formatCurrency(
                          Number(l.quantity) * Number(l.unit_price) || 0,
                        )}
                      </span>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Remove line"
                      disabled={lines.length === 1}
                      onClick={() => removeLine(l.key)}
                    >
                      <Trash2 />
                    </Button>
                    {sku &&
                    orderType === "standard" &&
                    Number(l.quantity) > sku.available ? (
                      <p className="w-full text-xs text-destructive">
                        Only {sku.available} available.
                      </p>
                    ) : null}
                  </div>
                )
              })
            )}

            <div className="flex items-center justify-between">
              <Button
                variant="outline"
                size="sm"
                onClick={addLine}
                disabled={siteSkus.length === 0}
              >
                <Plus data-icon="inline-start" /> Add line
              </Button>
              <div className="text-sm">
                <span className="text-muted-foreground">Subtotal </span>
                <span className="font-semibold tabular-nums">
                  {formatCurrency(orderTotal)}
                </span>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Ship to (optional)</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" value={shipName} onChange={setShipName} />
            <Field
              label="Address line 1"
              value={shipAddr1}
              onChange={setShipAddr1}
            />
            <Field
              label="Address line 2"
              value={shipAddr2}
              onChange={setShipAddr2}
            />
            <Field label="City" value={shipCity} onChange={setShipCity} />
            <Field
              label="Region / state"
              value={shipRegion}
              onChange={setShipRegion}
            />
            <Field
              label="Postal code"
              value={shipPostal}
              onChange={setShipPostal}
            />
            <Field
              label="Country"
              value={shipCountry}
              onChange={setShipCountry}
            />
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Order</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="site">Site</Label>
              <Select
                id="site"
                value={siteId}
                onChange={(e) => changeSite(e.target.value)}
              >
                {sites.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="customer">Customer</Label>
              <Select
                id="customer"
                value={customerId}
                onChange={(e) => setCustomerId(e.target.value)}
              >
                <option value="">No customer</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name ?? "Unnamed"}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="type">Order type</Label>
              <Select
                id="type"
                value={orderType}
                onChange={(e) =>
                  setOrderType(e.target.value as "standard" | "layaway")
                }
              >
                {ORDER_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {ORDER_TYPE_LABEL[t]}
                  </option>
                ))}
              </Select>
              <p className="text-xs text-muted-foreground">
                {orderType === "layaway"
                  ? "Stock is removed now; payment taken later."
                  : "Stock is reserved until fulfilled or cancelled."}
              </p>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="sale-date">Sale date</Label>
              <Input
                id="sale-date"
                type="date"
                value={saleDate}
                onChange={(e) => setSaleDate(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Can be back- or post-dated; the entry date is recorded
                separately.
              </p>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="notes">Notes</Label>
              <Textarea
                id="notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Anything the packer should know…"
              />
            </div>
          </CardContent>
        </Card>

        {error ? (
          <div className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}

        <Button onClick={submit} disabled={isPending} className="w-full">
          {isPending ? "Creating…" : "Create order"}
        </Button>
      </div>
    </div>
  )
}

function Field({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (v: string) => void
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label className="text-xs">{label}</Label>
      <Input value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  )
}
