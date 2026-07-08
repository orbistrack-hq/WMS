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
  // null = a shared default (admin-managed); non-null = owned by that site.
  site_id: string | null
  site_name: string | null
}

type Site = { id: string; name: string }

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
  canManageShared,
  sites,
}: {
  types: PackagingType[]
  canManageShared: boolean
  // Sites the current user can access (RLS-scoped). Drives the owner picker.
  sites: Site[]
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
  // Owner of a new type: "" = shared default (admin only), else a site id.
  const [newSiteId, setNewSiteId] = useState<string>(
    canManageShared ? "" : sites[0]?.id ?? "",
  )

  const accessibleSiteIds = new Set(sites.map((s) => s.id))
  // A shared default is admin-only; an owned type is manageable by anyone who can
  // access its site (which, per RLS, is the only reason it's on this list).
  const canManageRow = (t: PackagingType) =>
    canManageShared || (t.site_id != null && accessibleSiteIds.has(t.site_id))
  // Non-admins can only add types they own, so they need at least one site.
  const canAdd = canManageShared || sites.length > 0

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
    if (!canManageShared && !newSiteId) {
      setError("Pick which site owns this type.")
      return
    }
    setError(null)
    startTransition(async () => {
      const res = await createPackagingType(
        newName,
        newKind,
        Number(newCost || 0),
        newSiteId || null,
      )
      if (!res.ok) setError(res.error)
      else {
        setNewName("")
        setNewKind("box")
        setNewCost("")
        setNewSiteId(canManageShared ? "" : sites[0]?.id ?? "")
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
                    {t.site_id ? (
                      <Badge variant="outline">{t.site_name ?? "Site"}</Badge>
                    ) : (
                      <Badge variant="muted">Shared</Badge>
                    )}
                    {t.is_active ? (
                      <Badge variant="success">Active</Badge>
                    ) : (
                      <Badge variant="muted">Inactive</Badge>
                    )}
                    {canManageRow(t) ? (
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

      {canAdd ? (
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
            <Label className="text-xs">Owner</Label>
            <Select
              value={newSiteId}
              onChange={(e) => setNewSiteId(e.target.value)}
              className="w-40"
            >
              {canManageShared ? (
                <option value="">Shared (all sites)</option>
              ) : null}
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
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
          You don&apos;t have a site assigned, so there&apos;s nothing you can add
          here yet. Shared defaults are managed by an admin.
        </p>
      )}
    </div>
  )
}
