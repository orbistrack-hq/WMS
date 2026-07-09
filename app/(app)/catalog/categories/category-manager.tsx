"use client"

import { useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { AlertCircle, Check, Pencil, Plus, Trash2, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Combobox } from "@/components/ui/combobox"
import {
  buildCategoryTree,
  flattenCategoryTree,
  descendantIds,
  type CategoryNode,
  type CategoryRow,
} from "@/lib/catalog/types"
import {
  createCategory,
  deleteCategory,
  renameCategory,
  reparentCategory,
} from "../actions"

export function CategoryManager({
  categories,
  canManage,
}: {
  categories: CategoryRow[]
  canManage: boolean
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const [newName, setNewName] = useState("")
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState("")

  const flat = useMemo(
    () => flattenCategoryTree(buildCategoryTree(categories)),
    [categories],
  )

  function run(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null)
    startTransition(async () => {
      const res = await fn()
      if (!res.ok) setError(res.error ?? "Something went wrong.")
      else router.refresh()
    })
  }

  function addTopLevel() {
    if (!newName.trim()) return
    setError(null)
    startTransition(async () => {
      const res = await createCategory(newName, null)
      if (!res.ok) setError(res.error)
      else {
        setNewName("")
        router.refresh()
      }
    })
  }

  function commitRename(id: string) {
    if (!renameValue.trim()) return
    setError(null)
    startTransition(async () => {
      const res = await renameCategory(id, renameValue)
      if (!res.ok) setError(res.error)
      else {
        setRenamingId(null)
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

      {flat.length === 0 ? (
        <p className="text-sm text-muted-foreground">No categories yet.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
          {flat.map((node) => (
            <li
              key={node.id}
              className="flex items-center gap-2 px-3 py-2 text-sm"
            >
              <div
                className="min-w-0 flex-1"
                style={{ paddingLeft: `${node.depth * 1.25}rem` }}
              >
                {renamingId === node.id ? (
                  <div className="flex items-center gap-1.5">
                    <Input
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      className="h-7 w-48"
                      autoFocus
                    />
                    <Button
                      size="icon-sm"
                      aria-label="Save name"
                      disabled={isPending}
                      onClick={() => commitRename(node.id)}
                    >
                      <Check />
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="Cancel"
                      onClick={() => setRenamingId(null)}
                    >
                      <X />
                    </Button>
                  </div>
                ) : (
                  <span className="font-medium">
                    {node.depth > 0 ? (
                      <span className="text-muted-foreground">↳ </span>
                    ) : null}
                    {node.name}
                  </span>
                )}
              </div>

              {canManage && renamingId !== node.id ? (
                <div className="flex shrink-0 items-center gap-1">
                  <ReparentSelect
                    node={node}
                    all={flat}
                    rows={categories}
                    disabled={isPending}
                    onChange={(parentId) =>
                      run(() => reparentCategory(node.id, parentId))
                    }
                  />
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Rename"
                    onClick={() => {
                      setError(null)
                      setRenamingId(node.id)
                      setRenameValue(node.name)
                    }}
                  >
                    <Pencil />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Add sub-category"
                    onClick={() =>
                      run(() => createCategory("New category", node.id))
                    }
                  >
                    <Plus />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Delete"
                    disabled={isPending}
                    onClick={() => {
                      if (
                        confirm(`Delete "${node.name}"? Sub-categories must be moved first.`)
                      )
                        run(() => deleteCategory(node.id))
                    }}
                  >
                    <Trash2 />
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {canManage ? (
        <div className="flex items-center gap-2">
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="New top-level category…"
            className="w-64"
            onKeyDown={(e) => {
              if (e.key === "Enter") addTopLevel()
            }}
          />
          <Button onClick={addTopLevel} disabled={isPending || !newName.trim()}>
            <Plus data-icon="inline-start" /> Add
          </Button>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Categories can only be edited by a manager or administrator.
        </p>
      )}
    </div>
  )
}

function ReparentSelect({
  node,
  all,
  rows,
  disabled,
  onChange,
}: {
  node: CategoryNode
  all: CategoryNode[]
  rows: CategoryRow[]
  disabled: boolean
  onChange: (parentId: string | null) => void
}) {
  // A category may not move under itself or any of its descendants.
  const blocked = descendantIds(rows, node.id)
  const options = all.filter((n) => !blocked.has(n.id))

  return (
    <Combobox
      aria-label={`Move ${node.name}`}
      className="w-44"
      disabled={disabled}
      value={node.parent_id ?? ""}
      onValueChange={(v) => onChange(v || null)}
      options={[
        { value: "", label: "(top level)" },
        ...options.map((n) => ({ value: n.id, label: n.path })),
      ]}
      searchPlaceholder="Search categories…"
      emptyText="No category."
    />
  )
}
