"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { AlertCircle, Check, Pencil, Plus, Power, Trash2, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select } from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { formatCurrency } from "@/lib/format"
import {
  createPackagingType,
  deletePackagingType,
  setPackagingTypeActive,
  updatePackagingType,
} from "./actions"

// Mirrors the kind CHECK constraint on packaging_types.
const PACKAGING_KINDS = [
  "box",
  "shipping_label",
  "jar",
  "jar_label",
  "vacuum_bag",
  "custom",
] as const

export type PackagingType = {
  id: string
  name: string
  kind: string
  unit_cost: number
  is_active: boolean
}

const KIND_LABEL: Record<string, string> = {
  box: "Box",
  shipping_label: "Shipping label",
  jar: "Jar",
  jar_label: "Jar label",
  vacuum_bag: "Vacuum bag",
  custom: "Custom",
}

export function PackagingManager({
  types,
  canManage,
}: {
  types: PackagingType[]
  canManage: boolean
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState("")
  const [editKind, setEditKind] = useState<string>("box")
  const [editCost, setEditCost] = useState("")

  const [newName, setNewName] = useState("")
  const [newKind, setNewKind] = useState<string>("box")
  const [newCost, setNewCost] = useState("")

  function run(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null)
    startTransition(async () => {
      const res = await fn()
      if (!res.ok) setError(res.error ?? "Something went wrong.")
      else router.refresh()
    })
  }

  function beginEdit(t: PackagingType) {
    setError(null)
    setEditingId(t.id)
    setEditName(t.name)
    setEditKind(t.kind)
    setEditCost(String(t.unit_cost))
  }

  function saveEdit(id: string) {
    if (!editName.trim()) {
      setError("Name is required.")
      return
    }
    setError(null)
    startTransition(async () => {
      const res = await updatePackagingType(
        id,
        editName,
        editKind,
        Number(editCost || 0),
      )
      if (!res.ok) setError(res.error)
      else {
        setEditingId(null)
        router.refresh()
      }
    })
  }

  function add() {
    if (!newName.trim()) {
      setError("Name is required.")
      return
    }
    setError(null)
    startTransition(async () => {
      const res = await createPackagingType(
        newName,
        newKind,
        Number(newCost || 0),
      )
      if (!res.ok) setError(res.error)
      else {
        setNewName("")
        setNewKind("box")
        setNewCost("")
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

      {types.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No packaging types yet. Add boxes, jars, labels, and bags below.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
          {types.map((t) => (
            <li
              key={t.id}
              className="flex items-center justify-between gap-2 px-3 py-2 text-sm"
            >
              {editingId === t.id ? (
                <div className="flex flex-1 flex-wrap items-end gap-2">
                  <div className="flex flex-col gap-1">
                    <Label className="text-xs">Name</Label>
                    <Input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      className="w-40"
                      autoFocus
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label className="text-xs">Kind</Label>
                    <Select
                      value={editKind}
                      onChange={(e) => setEditKind(e.target.value)}
                      className="w-36"
                    >
                      {PACKAGING_KINDS.map((k) => (
                        <option key={k} value={k}>
                          {KIND_LABEL[k]}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label className="text-xs">Unit cost</Label>
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      value={editCost}
                      onChange={(e) => setEditCost(e.target.value)}
                      className="w-24"
                    />
                  </div>
                  <Button
                    size="icon-sm"
                    aria-label="Save"
                    disabled={isPending}
                    onClick={() => saveEdit(t.id)}
                  >
                    <Check />
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
              ) : (
                <>
                  <div className="flex min-w-0 flex-col">
                    <span className="font-medium">{t.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {KIND_LABEL[t.kind] ?? t.kind} ·{" "}
                      {formatCurrency(t.unit_cost)}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {t.is_active ? (
                      <Badge variant="success">Active</Badge>
                    ) : (
                      <Badge variant="muted">Inactive</Badge>
                    )}
                    {canManage ? (
                      <>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label="Edit"
                          disabled={isPending}
                          onClick={() => beginEdit(t)}
                        >
                          <Pencil />
                        </Button>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={t.is_active ? "Deactivate" : "Activate"}
                          disabled={isPending}
                          onClick={() =>
                            run(() => setPackagingTypeActive(t.id, !t.is_active))
                          }
                        >
                          <Power />
                        </Button>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label="Delete"
                          disabled={isPending}
                          onClick={() => {
                            if (
                              confirm(
                                `Delete "${t.name}"? If it's in packing history this will fail — deactivate instead.`,
                              )
                            )
                              run(() => deletePackagingType(t.id))
                          }}
                        >
                          <Trash2 />
                        </Button>
                      </>
                    ) : null}
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {canManage ? (
        <div className="flex flex-wrap items-end gap-2 rounded-lg border border-border p-3">
          <div className="flex min-w-40 flex-1 flex-col gap-1">
            <Label className="text-xs">Name</Label>
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="e.g. 8oz Jar"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs">Kind</Label>
            <Select
              value={newKind}
              onChange={(e) => setNewKind(e.target.value)}
              className="w-36"
            >
              {PACKAGING_KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs">Unit cost</Label>
            <Input
              type="number"
              step="0.01"
              min="0"
              value={newCost}
              onChange={(e) => setNewCost(e.target.value)}
              className="w-24"
              placeholder="0.00"
            />
          </div>
          <Button onClick={add} disabled={isPending || !newName.trim()}>
            <Plus data-icon="inline-start" /> Add type
          </Button>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Only an admin can add or edit packaging types.
        </p>
      )}
    </div>
  )
}
