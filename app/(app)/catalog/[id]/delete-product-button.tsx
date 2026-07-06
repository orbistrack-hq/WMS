"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Trash2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { deleteProduct } from "../actions"

/**
 * Admin-only "Delete product". The DB blocks it (clear message) while the
 * product still has child SKUs or any intake/allocation history; deactivate
 * those instead. On success the product is gone, so we return to the catalog.
 */
export function DeleteProductButton({ productId }: { productId: string }) {
  const router = useRouter()
  const [error, setError] = React.useState<string | null>(null)
  const [pending, startTransition] = React.useTransition()

  function run() {
    if (
      !window.confirm(
        "Delete this product? This permanently removes it from the catalog. " +
          "Blocked if it still has child SKUs or any intake/allocation history — deactivate instead.",
      )
    )
      return
    setError(null)
    startTransition(async () => {
      const res = await deleteProduct(productId)
      if (!res.ok) {
        setError(res.error)
        return
      }
      router.push("/catalog")
    })
  }

  return (
    <div className="ml-auto flex flex-col items-end gap-1">
      <Button
        variant="outline"
        size="sm"
        className="text-destructive hover:text-destructive"
        disabled={pending}
        onClick={run}
      >
        <Trash2 className="size-4" /> {pending ? "Deleting…" : "Delete product"}
      </Button>
      {error ? (
        <p className="max-w-xs text-xs whitespace-pre-line text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}
