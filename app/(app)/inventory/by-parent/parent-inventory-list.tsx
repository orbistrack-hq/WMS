"use client"

import { Fragment, useState, useTransition, type ReactNode } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import {
  ChevronDown,
  ChevronRight,
  MapPin,
  Check,
  X,
  Pencil,
  AlertCircle,
  PackagePlus,
  SlidersHorizontal,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { cn } from "@/lib/utils"
import { formatCurrency } from "@/lib/format"
import { updateProductSku } from "@/app/(app)/catalog/actions"
import { adjustStock, receiveStock } from "@/app/(app)/inventory/actions"

export type ParentChild = {
  child_sku_id: string
  site_id: string
  site_name: string
  sku: string | null
  bin_location: string | null
  grams: number | null
  variant_label: string | null
  on_hand: number
  available: number
  reserved: number
  layby: number
  cost: number
  price: number | null
}

export type ParentGroup = {
  product_id: string
  product_name: string
  /** WMS-only parent SKU code (FB-8); null when unset. */
  parent_sku: string | null
  sites: string[]
  children: ParentChild[]
  totals: {
    on_hand: number
    available: number
    reserved: number
    layby: number
    value: number
  }
  weightCount: number
}

export function ParentInventoryList({
  parents,
  totalCount,
}: {
  parents: ParentGroup[]
  /** Total parents across all pages (defaults to the visible count). */
  totalCount?: number
}) {
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [editingChild, setEditingChild] = useState<string | null>(null)
  const parentTotal = totalCount ?? parents.length

  const allOpen = open.size === parents.length
  function toggle(id: string) {
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  function toggleAll() {
    setOpen(allOpen ? new Set() : new Set(parents.map((p) => p.product_id)))
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between px-1 text-sm text-muted-foreground">
        <span>
          {parentTotal} parent SKU{parentTotal === 1 ? "" : "s"}
        </span>
        <button
          type="button"
          onClick={toggleAll}
          className="font-medium text-foreground hover:underline"
        >
          {allOpen ? "Collapse all" : "Expand all"}
        </button>
      </div>

      {parents.map((p) => {
        const isOpen = open.has(p.product_id)
        return (
          <Card key={p.product_id} className="overflow-hidden p-0">
            <button
              type="button"
              onClick={() => toggle(p.product_id)}
              aria-expanded={isOpen}
              className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/40"
            >
              {isOpen ? (
                <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium">{p.product_name}</span>
                  {p.parent_sku ? (
                    <Badge variant="outline" className="shrink-0 font-mono">
                      {p.parent_sku}
                    </Badge>
                  ) : null}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  {p.sites.map((site) => (
                    <Badge key={site} variant="outline" className="gap-1">
                      <MapPin className="size-3 text-muted-foreground" />
                      {site}
                    </Badge>
                  ))}
                  <Badge variant="secondary">
                    {p.weightCount} weight{p.weightCount === 1 ? "" : "s"}
                  </Badge>
                </div>
              </div>
              <dl className="hidden shrink-0 gap-4 text-right text-sm sm:flex">
                <Metric label="On hand" value={p.totals.on_hand} />
                <Metric label="Available" value={p.totals.available} emphasis />
                <Metric label="Reserved" value={p.totals.reserved} />
                <Metric label="Value" text={formatCurrency(p.totals.value)} />
              </dl>
            </button>

            {isOpen ? (
              <div className="border-t bg-muted/20">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Weight</TableHead>
                      <TableHead>Site</TableHead>
                      <TableHead>SKU</TableHead>
                      <TableHead>Bin</TableHead>
                      <TableHead className="text-right">On hand</TableHead>
                      <TableHead className="text-right">Available</TableHead>
                      <TableHead className="text-right">Reserved</TableHead>
                      <TableHead className="text-right">Cost</TableHead>
                      <TableHead className="text-right">Price</TableHead>
                      <TableHead className="w-0 text-right">
                        <span className="sr-only">Actions</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {p.children.map((c, i) => {
                      const prev = p.children[i - 1]
                      const newWeight =
                        !prev || prev.grams !== c.grams
                      return (
                        <Fragment key={c.child_sku_id}>
                        <TableRow>
                          <TableCell>
                            {newWeight ? (
                              <Badge variant="info">
                                {c.variant_label ?? "No weight"}
                              </Badge>
                            ) : (
                              <span className="text-muted-foreground/50">
                                ↳
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {c.site_name}
                          </TableCell>
                          <TableCell>
                            <Link
                              href={`/inventory/${c.child_sku_id}`}
                              className="text-muted-foreground hover:underline"
                            >
                              {c.sku ?? "—"}
                            </Link>
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {c.bin_location ?? "—"}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {c.on_hand}
                          </TableCell>
                          <TableCell className="text-right font-medium tabular-nums">
                            {c.available}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {c.reserved > 0 ? (
                              <Badge variant="info">{c.reserved}</Badge>
                            ) : (
                              <span className="text-muted-foreground">0</span>
                            )}
                          </TableCell>
                          <TableCell className="text-right tabular-nums text-muted-foreground">
                            {formatCurrency(c.cost)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums text-muted-foreground">
                            {c.price == null ? "—" : formatCurrency(c.price)}
                          </TableCell>
                          <TableCell className="text-right">
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 px-2"
                              aria-expanded={editingChild === c.child_sku_id}
                              onClick={() =>
                                setEditingChild((cur) =>
                                  cur === c.child_sku_id
                                    ? null
                                    : c.child_sku_id,
                                )
                              }
                            >
                              <Pencil className="size-3.5" />
                              <span className="sr-only">Edit stock</span>
                            </Button>
                          </TableCell>
                        </TableRow>
                        {editingChild === c.child_sku_id ? (
                          <TableRow>
                            <TableCell
                              colSpan={10}
                              className="bg-background p-0"
                            >
                              <RowStockEditor
                                child={c}
                                onDone={() => setEditingChild(null)}
                              />
                            </TableCell>
                          </TableRow>
                        ) : null}
                        </Fragment>
                      )
                    })}
                  </TableBody>
                </Table>
                <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
                  <ParentSkuEditor
                    productId={p.product_id}
                    initial={p.parent_sku}
                  />
                  <Link
                    href={`/catalog/${p.product_id}`}
                    className="text-xs font-medium text-muted-foreground hover:text-foreground hover:underline"
                  >
                    Edit parent in catalog →
                  </Link>
                </div>
              </div>
            ) : null}
          </Card>
        )
      })}
    </div>
  )
}

/** Inline edit of the WMS-only parent SKU code (FB-8). */
function ParentSkuEditor({
  productId,
  initial,
}: {
  productId: string
  initial: string | null
}) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(initial ?? "")
  const [current, setCurrent] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  function save() {
    setError(null)
    const next = value.trim()
    startTransition(async () => {
      const res = await updateProductSku(productId, next || null)
      if (!res.ok) {
        setError(res.error)
        return
      }
      setCurrent(next || null)
      setEditing(false)
    })
  }

  function cancel() {
    setValue(current ?? "")
    setError(null)
    setEditing(false)
  }

  if (!editing) {
    return (
      <div className="flex items-center gap-2 text-xs">
        <span className="text-muted-foreground">Parent SKU</span>
        {current ? (
          <Badge variant="outline" className="font-mono">
            {current}
          </Badge>
        ) : (
          <span className="text-muted-foreground/60">— none</span>
        )}
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="inline-flex items-center gap-1 font-medium text-muted-foreground hover:text-foreground hover:underline"
        >
          <Pencil className="size-3" />
          {current ? "Edit" : "Add"}
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <Input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") save()
            if (e.key === "Escape") cancel()
          }}
          placeholder="e.g. AF"
          className="h-8 w-32 font-mono"
        />
        <Button size="sm" onClick={save} disabled={isPending} className="h-8">
          <Check className="size-4" /> Save
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={cancel}
          disabled={isPending}
          className="h-8"
        >
          <X className="size-4" />
        </Button>
      </div>
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </div>
  )
}

type EditMode = "receive" | "adjust"

/**
 * Compact inline Receive/Adjust form for a single child SKU, reusing the same
 * server actions as the child detail screen so ledger + revalidation stay
 * identical. Receives log a receipt; adjustments require a note.
 */
function RowStockEditor({
  child,
  onDone,
}: {
  child: ParentChild
  onDone: () => void
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [mode, setMode] = useState<EditMode>("receive")
  const [qty, setQty] = useState("")
  const [delta, setDelta] = useState("")
  const [note, setNote] = useState("")
  const [error, setError] = useState<string | null>(null)

  const projected =
    mode === "receive"
      ? child.on_hand + (Number(qty) || 0)
      : child.on_hand + (Number(delta) || 0)

  function submit() {
    setError(null)
    startTransition(async () => {
      let res
      if (mode === "receive") {
        const n = Number(qty)
        if (!(n > 0)) {
          setError("Enter a quantity to receive.")
          return
        }
        res = await receiveStock(child.child_sku_id, n, note || null)
      } else {
        const d = Number(delta)
        if (!d) {
          setError("Enter a non-zero adjustment.")
          return
        }
        if (!note.trim()) {
          setError("A note is required for manual adjustments.")
          return
        }
        res = await adjustStock(child.child_sku_id, d, note)
      }
      if (!res.ok) {
        setError(res.error)
        return
      }
      router.refresh()
      onDone()
    })
  }

  return (
    <div className="flex flex-col gap-3 border-l-2 border-primary/40 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">Edit stock</span>
        <span className="text-muted-foreground">
          {child.site_name} · {child.variant_label ?? "No weight"} ·{" "}
          {child.sku ?? "—"}
        </span>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex gap-1 rounded-lg bg-muted p-0.5">
          <EditModeButton
            active={mode === "receive"}
            onClick={() => {
              setMode("receive")
              setError(null)
            }}
          >
            <PackagePlus className="size-4" /> Receive
          </EditModeButton>
          <EditModeButton
            active={mode === "adjust"}
            onClick={() => {
              setMode("adjust")
              setError(null)
            }}
          >
            <SlidersHorizontal className="size-4" /> Adjust
          </EditModeButton>
        </div>

        {mode === "receive" ? (
          <div className="flex flex-col gap-1">
            <Label htmlFor={`qty-${child.child_sku_id}`}>Quantity received</Label>
            <Input
              id={`qty-${child.child_sku_id}`}
              type="number"
              min="1"
              step="1"
              autoFocus
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              placeholder="0"
              className="w-32"
            />
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            <Label htmlFor={`delta-${child.child_sku_id}`}>
              Adjustment (+/−)
            </Label>
            <Input
              id={`delta-${child.child_sku_id}`}
              type="number"
              step="1"
              autoFocus
              value={delta}
              onChange={(e) => setDelta(e.target.value)}
              placeholder="e.g. -2"
              className="w-32"
            />
          </div>
        )}

        <div className="flex min-w-48 flex-1 flex-col gap-1">
          <Label htmlFor={`note-${child.child_sku_id}`}>
            Note{mode === "adjust" ? " (required)" : " (optional)"}
          </Label>
          <Textarea
            id={`note-${child.child_sku_id}`}
            rows={1}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={
              mode === "receive"
                ? "PO number, supplier…"
                : "Reason for the adjustment…"
            }
            className="min-h-9"
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <p className="text-xs text-muted-foreground">
          On hand {child.on_hand} →{" "}
          <span className="font-medium text-foreground tabular-nums">
            {projected}
          </span>
        </p>
        <div className="ml-auto flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={onDone}
            disabled={isPending}
          >
            Cancel
          </Button>
          <Button size="sm" onClick={submit} disabled={isPending}>
            {isPending
              ? "Saving…"
              : mode === "receive"
                ? "Receive stock"
                : "Post adjustment"}
          </Button>
        </div>
      </div>

      {error ? (
        <div className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}
    </div>
  )
}

function EditModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center justify-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors",
        active
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  )
}

function Metric({
  label,
  value,
  text,
  emphasis,
}: {
  label: string
  value?: number
  text?: string
  emphasis?: boolean
}) {
  return (
    <div className="min-w-14">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={`tabular-nums ${emphasis ? "font-semibold" : "font-medium"}`}
      >
        {text ?? value}
      </dd>
    </div>
  )
}
