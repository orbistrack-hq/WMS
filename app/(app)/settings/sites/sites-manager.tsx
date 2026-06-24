"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { AlertCircle, Check, Pencil, Plus, Power, Trash2, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import {
  createSite,
  deleteSite,
  setSiteActive,
  updateSite,
} from "./actions"

export type Site = {
  id: string
  name: string
  code: string | null
  is_active: boolean
}

export function SitesManager({
  sites,
  canManage,
}: {
  sites: Site[]
  canManage: boolean
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState("")
  const [editCode, setEditCode] = useState("")

  const [newName, setNewName] = useState("")
  const [newCode, setNewCode] = useState("")

  function run(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null)
    startTransition(async () => {
      const res = await fn()
      if (!res.ok) setError(res.error ?? "Something went wrong.")
      else router.refresh()
    })
  }

  function beginEdit(s: Site) {
    setError(null)
    setEditingId(s.id)
    setEditName(s.name)
    setEditCode(s.code ?? "")
  }

  function saveEdit(id: string) {
    if (!editName.trim()) {
      setError("Site name is required.")
      return
    }
    setError(null)
    startTransition(async () => {
      const res = await updateSite(id, editName, editCode)
      if (!res.ok) setError(res.error)
      else {
        setEditingId(null)
        router.refresh()
      }
    })
  }

  function add() {
    if (!newName.trim()) {
      setError("Site name is required.")
      return
    }
    setError(null)
    startTransition(async () => {
      const res = await createSite(newName, newCode)
      if (!res.ok) setError(res.error)
      else {
        setNewName("")
        setNewCode("")
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

      {sites.length === 0 ? (
        <p className="text-sm text-muted-foreground">No sites yet.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
          {sites.map((s) => (
            <li
              key={s.id}
              className="flex items-center justify-between gap-2 px-3 py-2 text-sm"
            >
              {editingId === s.id ? (
                <div className="flex flex-1 flex-wrap items-end gap-2">
                  <div className="flex flex-col gap-1">
                    <Label className="text-xs">Name</Label>
                    <Input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      className="w-44"
                      autoFocus
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label className="text-xs">Code</Label>
                    <Input
                      value={editCode}
                      onChange={(e) => setEditCode(e.target.value)}
                      className="w-28"
                      placeholder="optional"
                    />
                  </div>
                  <Button
                    size="icon-sm"
                    aria-label="Save"
                    disabled={isPending}
                    onClick={() => saveEdit(s.id)}
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
                    <span className="font-medium">{s.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {s.code ?? "no code"}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {s.is_active ? (
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
                          onClick={() => beginEdit(s)}
                        >
                          <Pencil />
                        </Button>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={s.is_active ? "Deactivate" : "Activate"}
                          disabled={isPending}
                          onClick={() =>
                            run(() => setSiteActive(s.id, !s.is_active))
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
                                `Delete "${s.name}"? If it has SKUs or orders this will fail — deactivate instead.`,
                              )
                            )
                              run(() => deleteSite(s.id))
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
          <div className="flex min-w-44 flex-1 flex-col gap-1">
            <Label className="text-xs">Site name</Label>
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="e.g. Main Warehouse"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs">Code</Label>
            <Input
              value={newCode}
              onChange={(e) => setNewCode(e.target.value)}
              className="w-28"
              placeholder="MAIN"
            />
          </div>
          <Button onClick={add} disabled={isPending || !newName.trim()}>
            <Plus data-icon="inline-start" /> Add site
          </Button>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Only an admin can add or edit sites.
        </p>
      )}
    </div>
  )
}
