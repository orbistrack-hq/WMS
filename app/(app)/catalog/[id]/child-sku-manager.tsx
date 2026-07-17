"use client"

import { Fragment, useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import {
  AlertCircle,
  ArrowRightLeft,
  PackageCheck,
  PackageX,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react"

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
import { SCANNING_ENABLED } from "@/lib/flags"
import {
  createChildSku,
  deleteChildSku,
  setChildTrackInventory,
  updateChildSku,
} from "../actions"
import { ReparentSku } from "./reparent-sku"

export type ChildSku = {
  id: string
  site_id: string
  site_name: string
  sku: string | null
  store_variant_id: string | null
  bin_location: string | null
  barcode: string | null
  grams_per_unit: number | null
  variant_label: string | null
  price: number
  cost: number
  is_active: boolean
  /** false = service/fee SKU: skips all inventory ops, never backorders. */
  track_inventory: boolean
  on_hand: number
  available: number
}

type SiteOption = { id: string; name: string }

type Draft = {
  sku: string
  store_variant_id: string
  bin_location: string
  barcode: string
  weight: string
  price: string
  cost: string
  is_active: boolean
}

const emptyDraft = (): Draft => ({
  sku: "",
  store_variant_id: "",
  bin_location: "",
  barcode: "",
  weight: "",
  price: "",
  cost: "",
  is_active: true,
})

/** Parse the weight (grams-per-unit) input; blank becomes null. */
function parseWeight(v: string): number | null {
  const t = v.trim()
  if (t === "") return null
  const n = Number(t)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** How a variant reads in the table: label, else "<grams>g", else a dash. */
function weightText(s: Pick<ChildSku, "variant_label" | "grams_per_unit">): string {
  if (s.variant_label) return s.variant_label
  return s.grams_per_unit == null ? "—" : `${s.grams_per_unit}g`
}

export function ChildSkuManager({
  productId,
  skus,
  availableSites,
  isAdmin = false,
  canManageInventory = false,
}: {
  productId: string
  skus: ChildSku[]
  availableSites: SiteOption[]
  isAdmin?: boolean
  canManageInventory?: boolean
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

  // A product carries a variant per site × weight, so the flat list gets long.
  // Group by site (sites A→Z; within a site, lightest weight first) and print a
  // site header once per group instead of repeating the site on every row.
  const siteGroups = useMemo(() => {
    const bySite = new Map<
      string,
      { site_id: string; site_name: string; items: ChildSku[] }
    >()
    for (const s of skus) {
      let g = bySite.get(s.site_id)
      if (!g) {
        g = { site_id: s.site_id, site_name: s.site_name, items: [] }
        bySite.set(s.site_id, g)
      }
      g.items.push(s)
    }
    const groups = [...bySite.values()]
    groups.sort((a, b) => a.site_name.localeCompare(b.site_name))
    for (const g of groups) {
      g.items.sort(
        (a, b) =>
          (a.grams_per_unit ?? Number.POSITIVE_INFINITY) -
            (b.grams_per_unit ?? Number.POSITIVE_INFINITY) ||
          (a.sku ?? "").localeCompare(b.sku ?? ""),
      )
    }
    return groups
  }, [skus])

  // Column count after dropping the per-row Site cell (the group header carries
  // the site now). Keep in sync with the header row below.
  const columnCount = SCANNING_ENABLED ? 11 : 10

  function handleDelete(s: ChildSku) {
    if (
      !window.confirm(
        `Delete SKU ${s.sku ?? s.id}? This permanently removes it from the catalog. ` +
          `Blocked if it has any orders, stock movements, or allocations — deactivate those instead.`,
      )
    )
      return
    setError(null)
    startTransition(async () => {
      const res = await deleteChildSku(s.id, productId)
      if (!res.ok) {
        setError(res.error)
        return
      }
      router.refresh()
    })
  }

  function handleToggleTrack(s: ChildSku) {
    const next = !s.track_inventory
    if (
      next === false &&
      !window.confirm(
        `Mark ${s.sku ?? "this SKU"} as a fee / non-inventory line? It will stop ` +
          `reserving, backordering, and consuming stock, and its stock counts will ` +
          `be ignored. Use for fee products like shipping protection.`,
      )
    )
      return
    setError(null)
    startTransition(async () => {
      const res = await setChildTrackInventory(s.id, productId, next)
      if (!res.ok) setError(res.error)
      else router.refresh()
    })
  }

  function beginEdit(s: ChildSku) {
    setError(null)
    setEditingId(s.id)
    setEditDraft({
      sku: s.sku ?? "",
      store_variant_id: s.store_variant_id ?? "",
      bin_location: s.bin_location ?? "",
      barcode: s.barcode ?? "",
      weight: s.grams_per_unit == null ? "" : String(s.grams_per_unit),
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
        barcode: editDraft.barcode || null,
        grams_per_unit: parseWeight(editDraft.weight),
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
        barcode: addDraft.barcode || null,
        grams_per_unit: parseWeight(addDraft.weight),
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
          No SKUs yet. Add one per weight variant below (e.g. 3.5g, 7g) for each
          client site — each carries its own weight, price, cost, and store
          variant ID.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Weight</TableHead>
              <TableHead>SKU</TableHead>
              <TableHead>Bin</TableHead>
              {SCANNING_ENABLED ? <TableHead>Barcode</TableHead> : null}
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
            {siteGroups.map((group) => (
              <Fragment key={group.site_id}>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableCell
                    colSpan={columnCount}
                    className="py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                  >
                    {group.site_name} · {group.items.length} SKU
                    {group.items.length === 1 ? "" : "s"}
                  </TableCell>
                </TableRow>
                {group.items.map((s) =>
                  editingId === s.id ? (
                    <TableRow key={s.id}>
                      <TableCell>
                        <Input
                          type="number"
                          step="0.5"
                          min="0"
                          value={editDraft.weight}
                          onChange={(e) =>
                            setEditDraft({ ...editDraft, weight: e.target.value })
                          }
                          className="w-20"
                          placeholder="g"
                        />
                      </TableCell>
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
                      {SCANNING_ENABLED ? (
                        <TableCell>
                          <Input
                            value={editDraft.barcode}
                            onChange={(e) =>
                              setEditDraft({
                                ...editDraft,
                                barcode: e.target.value,
                              })
                            }
                            className="w-28"
                          />
                        </TableCell>
                      ) : null}
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
                      <TableCell className="tabular-nums">
                        {weightText(s)}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {s.sku ?? "—"}
                      </TableCell>
                      <TableCell className="tabular-nums text-muted-foreground">
                        {s.bin_location ?? "—"}
                      </TableCell>
                      {SCANNING_ENABLED ? (
                        <TableCell className="tabular-nums text-muted-foreground">
                          {s.barcode ?? "—"}
                        </TableCell>
                      ) : null}
                      <TableCell className="text-muted-foreground">
                        {s.store_variant_id ?? "—"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCurrency(s.price)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCurrency(s.cost)}
                      </TableCell>
                      <TableCell
                        className="text-right tabular-nums text-muted-foreground"
                        title={
                          s.track_inventory
                            ? undefined
                            : "Inventory not tracked (fee SKU)"
                        }
                      >
                        {s.track_inventory ? s.on_hand : "—"}
                      </TableCell>
                      <TableCell
                        className="text-right tabular-nums text-muted-foreground"
                        title={
                          s.track_inventory
                            ? undefined
                            : "Inventory not tracked (fee SKU)"
                        }
                      >
                        {s.track_inventory ? s.available : "—"}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {s.is_active ? (
                            <Badge variant="success">Active</Badge>
                          ) : (
                            <Badge variant="muted">Inactive</Badge>
                          )}
                          {!s.track_inventory ? (
                            <Badge
                              variant="warning"
                              title="Service/fee SKU: skips reservation, backorder, and stock — inventory ignored"
                            >
                              Fee · no stock
                            </Badge>
                          ) : null}
                        </div>
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
                          {canManageInventory ? (
                            <Button
                              size="icon-sm"
                              variant="ghost"
                              aria-label={
                                s.track_inventory
                                  ? "Mark as fee / non-inventory SKU"
                                  : "Mark as tracked inventory SKU"
                              }
                              title={
                                s.track_inventory
                                  ? "Mark as fee / non-inventory (skips stock & backorder)"
                                  : "Mark as tracked inventory"
                              }
                              className={
                                s.track_inventory
                                  ? "text-amber-600 hover:text-amber-700"
                                  : ""
                              }
                              disabled={isPending}
                              onClick={() => handleToggleTrack(s)}
                            >
                              {s.track_inventory ? <PackageX /> : <PackageCheck />}
                            </Button>
                          ) : null}
                          {isAdmin ? (
                            <Button
                              size="icon-sm"
                              variant="ghost"
                              aria-label="Delete SKU"
                              title="Delete SKU (admin)"
                              className="text-destructive hover:text-destructive"
                              disabled={isPending}
                              onClick={() => handleDelete(s)}
                            >
                              <Trash2 />
                            </Button>
                          ) : null}
                        </div>
                      </TableCell>
                    </TableRow>
                  ),
                )}
              </Fragment>
            ))}
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
          No active sites yet — add a site before creating SKUs.
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
              <Label className="text-xs">Weight (g)</Label>
              <Input
                type="number"
                step="0.5"
                min="0"
                value={addDraft.weight}
                onChange={(e) =>
                  setAddDraft({ ...addDraft, weight: e.target.value })
                }
                className="w-24"
                placeholder="e.g. 3.5"
              />
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
            {SCANNING_ENABLED ? (
              <div className="flex flex-col gap-1">
                <Label className="text-xs">Barcode</Label>
                <Input
                  value={addDraft.barcode}
                  onChange={(e) =>
                    setAddDraft({ ...addDraft, barcode: e.target.value })
                  }
                  className="w-28"
                  placeholder="UPC / EAN"
                />
              </div>
            ) : null}
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
          <Plus data-icon="inline-start" /> Add child SKU
        </Button>
      )}
    </div>
  )
}
