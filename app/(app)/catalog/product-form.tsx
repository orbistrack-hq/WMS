"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { AlertCircle, Check } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import {
  createProduct,
  updateProduct,
  type ProductInput,
} from "./actions"

export type CategoryOption = { id: string; label: string }

type ProductValue = {
  id?: string
  name: string
  description: string | null
  category_id: string | null
  is_active: boolean
}

export function ProductForm({
  mode,
  categories,
  product,
}: {
  mode: "create" | "edit"
  categories: CategoryOption[]
  product?: ProductValue
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const [name, setName] = useState(product?.name ?? "")
  const [description, setDescription] = useState(product?.description ?? "")
  const [categoryId, setCategoryId] = useState(product?.category_id ?? "")
  const [isActive, setIsActive] = useState(product?.is_active ?? true)

  function submit() {
    setError(null)
    setSaved(false)
    if (!name.trim()) {
      setError("Name is required.")
      return
    }
    const input: ProductInput = {
      name,
      description: description || null,
      category_id: categoryId || null,
      is_active: isActive,
    }
    startTransition(async () => {
      const res =
        mode === "create"
          ? await createProduct(input)
          : await updateProduct(product!.id!, input)
      if (!res.ok) {
        setError(res.error)
        return
      }
      if (mode === "create" && "productId" in res) {
        router.push(`/catalog/${res.productId}`)
      } else {
        setSaved(true)
        router.refresh()
      }
    })
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <Label htmlFor="prod-name">Name</Label>
        <Input
          id="prod-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Wildflower Honey"
        />
        <p className="text-xs text-muted-foreground">
          Duplicate names are allowed — products are identified by ID, not name.
        </p>
      </div>

      <div className="flex flex-col gap-1">
        <Label htmlFor="prod-desc">Description</Label>
        <Textarea
          id="prod-desc"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>

      <div className="flex flex-col gap-1">
        <Label htmlFor="prod-cat">Category</Label>
        <Select
          id="prod-cat"
          value={categoryId}
          onChange={(e) => setCategoryId(e.target.value)}
        >
          <option value="">Uncategorized</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </Select>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="size-4 accent-primary"
          checked={isActive}
          onChange={(e) => setIsActive(e.target.checked)}
        />
        Active
      </label>

      {error ? (
        <div className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      <div className="flex items-center gap-2">
        <Button onClick={submit} disabled={isPending}>
          {isPending
            ? "Saving…"
            : mode === "create"
              ? "Create product"
              : "Save changes"}
        </Button>
        {saved ? (
          <span className="flex items-center gap-1 text-sm text-emerald-600">
            <Check className="size-4" /> Saved
          </span>
        ) : null}
      </div>
    </div>
  )
}
