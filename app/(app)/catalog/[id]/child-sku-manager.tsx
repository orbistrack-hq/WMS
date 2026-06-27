"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { AlertCircle, ArrowRightLeft, Pencil, Plus, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select } from "@/components/ui/select"
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
import { createChildSku, updateChildSku } from "../actions"
import { ReparentSku } from "./reparent-sku"

export type ChildSku = {
  id: string
  site_id: string
  site_name: string
  sku: string | null
  store_variant_id: string | null
  bin_location: string | null
  price: number
  cost: number
  is_active: boolean
  on_hand: number
  available: number
}

type SiteOption = { id: string; name: string }

type Draft = {
  sku: string
  store_variant_id: string
  bin_location: string
  price: string
  cost: string
  is_active: boolean
}

const emptyDraft = (): Draft => ({
  sku: "",
  store_variant_id: "",
  bin_location: "",
  price: "",
  cost: "",
  is_active: true,
})

export function ChildSkuManager({
  productId,
  skus,
  availableSites,
}: {
  productId: string
  skus: ChildSku[]
  availableSites: SiteOption[]
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState<Draft>(emptyDraft())

  const [movingId, setMovingId] = useState<string | null>(null)
  const movingSku = skus.find((s) => s.id === movingId) ?? null

  const [adding, setAdding] = useState(false)
  const [addSite, setAddSite] = useState(availableSites[0]?.id ?? "")
  const [addDraft, setAddDraft] = useState<Draft>(emptyDraft())

  function beginEdit(s: ChildSku) {
    setError(null)
    setEditingId(s.id)
    setEditDraft({
      sku: s.sku ?? "",
      store_variant_id: s.store_variant_id ?? "",
      bin_location: s.bin_location ?? "",
      price: String(s.price),
      cost: String(s.cost),
      is_active: s.is_active,
    })
  }

  function saveEdit(s: ChildSku) {
    setError(null)
    startTransition(async () => {
      const res = await updateChildSku(s.id, productId, {
        sku: editDraft.sku || null,
        store_variant_id: editDraft.store_variant_id || null,
        bin_location: editDraft.bin_location || null,
        price: Number(editDraft.price),
        cost: Number(editDraft.cost),
        is_active: editDraft.is_active,
      })
      if (!res.ok) setError(res.error)
      else {
        setEditingId(null)
        router.refresh()
      }
    })
  }

  function saveAdd() {
    setError(null)
    if (!addSite) {
      setError("Pick a site.")
      return
    }
    startTransition(async () => {
      const res = await createChildSku({
        product_id: productId,
        site_id: addSite,
        sku: addDraft.sku || null,
        store_variant_id: addDraft.store_variant_id || null,
        bin_location: addDraft.bin_location || null,
        price: Number(addDraft.price || 0),
        cost: Number(addDraft.cost || 0),
        is_active: addDraft.is_active,
      })
      if (!res.ok) setError(res.error)
      else {
        setAdding(false)
        setAddDraft(emptyDraft())
        router.refresh()
      }
    })
  }

  return (
    <div className="flex flex-col gap-3">
      {error ? (
        <div className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      {skus.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No SKUs yet. Add one per site below — each carries its own price,
          cost, and store variant ID.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Site</TableHead>
              <TableHead>SKU</TableHead>
              <TableHead>Bin</TableHead>
              <TableHead>Variant ID</TableHead>
              <TableHead className="text-right">Price</TableHead>
              <TableHead className="text-right">Cost</TableHead>
              <TableHead className="text-right">On hand</TableHead>
              <TableHead className="text-right">Avail</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-px" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {skus.map((s) =>
              editingId === s.id ? (
                <TableRow key={s.id}>
                  <TableCell className="font-medium">{s.site_name}</TableCell>
                  <TableCell>
                    <Input
                      value={editDraft.sku}
                      onChange={(e) =>
                        setEditDraft({ ...editDraft, sku: e.target.value })
                      }
                      className="w-32"
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      value={editDraft.bin_location}
                      onChange={(e) =>
                        setEditDraft({
                          ...editDraft,
                          bin_location: e.target.value,
                        })
                      }
                      className="w-24"
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      value={editDraft.store_variant_id}
                      onChange={(e) =>
                        setEditDraft({
                          ...editDraft,
                          store_variant_id: e.target.value,
                        })
                      }
                      className="w-28"
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      value={editDraft.price}
                      onChange={(e) =>
                        setEditDraft({ ...editDraft, price: e.target.value })
                      }
                      className="w-20 text-right"
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      value={editDraft.cost}
                      onChange={(e) =>
                        setEditDraft({ ...editDraft, cost: e.target.value })
                      }
                      className="w-20 text-right"
                    />
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {s.on_hand}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {s.available}
                  </TableCell>
                  <TableCell>
                    <label className="flex items-center gap-1.5 text-xs">
                      <input
                        type="checkbox"
                        className="size-4 accent-primary"
                        checked={editDraft.is_active}
                        onChange={(e) =>
                          setEditDraft({
                            ...editDraft,
                            is_active: e.target.checked,
                          })
                        }
                      />
                      Active
                    </label>
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Button
                        size="sm"
                        disabled={isPending}
                        onClick={() => saveEdit(s)}
                      >
                        Save
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label="Cancel"
                        onClick={() => setEditingId(null)}
                      >
                        <X />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                <TableRow key={s.id}>
                  <TableCell className="font-medium">{s.site_name}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {s.sku ?? "—"}
                  </TableCell>
                  <TableCell className="tabular-nums text-muted-foreground">
                    {s.bin_location ?? "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {s.store_variant_id ?? "—"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCurrency(s.price)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCurrency(s.cost)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {s.on_hand}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {s.available}
                  </TableCell>
                  <TableCell>
                    {s.is_active ? (
                      <Badge variant="success">Active</Badge>
                    ) : (
                      <Badge variant="muted">Inactive</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label="Edit SKU"
                        onClick={() => beginEdit(s)}
                      >
                        <Pencil />
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label="Move SKU to another product"
                        title="Move to another product"
                        onClick={() => {
                          setError(null)
                          setEditingId(null)
                          setMovingId(s.id)
                        }}
                      >
                        <ArrowRightLeft />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ),
            )}
          </TableBody>
        </Table>
      )}

      {/* Move SKU to another product */}
      {movingSku ? (
        <ReparentSku
          productId={productId}
          sku={{
            id: movingSku.id,
            sku: movingSku.sku,
            site_name: movingSku.site_name,
          }}
          onClose={() => setMovingId(null)}
        />
      ) : null}

      {/* Add SKU */}
      {availableSites.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Every site already has a SKU for this product.
        </p>
      ) : adding ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1">
              <Label className="text-xs">Site</Label>
              <Select
                value={addSite}
                onChange={(e) => setAddSite(e.target.value)}
                className="w-40"
              >
                {availableSites.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-xs">SKU code</Label>
              <Input
                value={addDraft.sku}
                onChange={(e) =>
                  setAddDraft({ ...addDraft, sku: e.target.value })
                }
                className="w-32"
                placeholder="optional"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-xs">Bin</Label>
              <Input
                value={addDraft.bin_location}
                onChange={(e) =>
                  setAddDraft({ ...addDraft, bin_location: e.target.value })
                }
                className="w-24"
                placeholder="A-12-3"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-xs">Variant ID</Label>
              <Input
                value={addDraft.store_variant_id}
                onChange={(e) =>
                  setAddDraft({
                    ...addDraft,
                    store_variant_id: e.target.value,
                  })
                }
                className="w-28"
                placeholder="optional"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-xs">Price</Label>
              <Input
                type="number"
                step="0.01"
                min="0"
                value={addDraft.price}
                onChange={(e) =>
                  setAddDraft({ ...addDraft, price: e.target.value })
                }
                className="w-20"
                placeholder="0.00"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-xs">Cost</Label>
              <Input
                type="number"
                step="0.01"
                min="0"
                value={addDraft.cost}
                onChange={(e) =>
                  setAddDraft({ ...addDraft, cost: e.target.value })
                }
                className="w-20"
                placeholder="0.00"
              />
            </div>
            <Button disabled={isPending} onClick={saveAdd}>
              Add
            </Button>
            <Button
              variant="ghost"
              onClick={() => setAdding(false)}
              disabled={isPending}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() => {
            setError(null)
            setAdding(true)
          }}
        >
          <Plus data-icon="inline-start" /> Add SKU
        </Button>
      )}
    </div>
  )
}
