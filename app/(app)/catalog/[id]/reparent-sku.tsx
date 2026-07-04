"use client"

import { useEffect, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { AlertCircle, ArrowRightLeft, Check, Search, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import {
  reparentChildSku,
  searchProducts,
  type ProductSearchResult,
} from "../actions"

type MovingSku = {
  id: string
  sku: string | null
  site_name: string
}

/**
 * Inline panel for moving a child SKU onto a different master product. Searches
 * products by name (debounced) so the operator never scrolls a giant dropdown —
 * a preview of the searchable-combobox direction for the rest of the app.
 */
export function ReparentSku({
  productId,
  sku,
  onClose,
}: {
  productId: string
  sku: MovingSku
  onClose: () => void
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const [query, setQuery] = useState("")
  const [results, setResults] = useState<ProductSearchResult[]>([])
  // Starts true so the first (on-mount) load shows the searching state.
  const [searching, setSearching] = useState(true)
  const [selected, setSelected] = useState<ProductSearchResult | null>(null)

  // Debounced search. Empty query lists the first products alphabetically.
  // `selected`/`searching` are reset in the input handler (not here) to avoid a
  // synchronous setState in the effect body (react-hooks/set-state-in-effect).
  useEffect(() => {
    const handle = setTimeout(async () => {
      const res = await searchProducts(query, productId)
      if (res.ok) setResults(res.products)
      else setError(res.error)
      setSearching(false)
    }, 200)
    return () => clearTimeout(handle)
  }, [query, productId])

  function confirmMove() {
    if (!selected) return
    setError(null)
    startTransition(async () => {
      const res = await reparentChildSku(sku.id, productId, selected.id)
      if (!res.ok) setError(res.error)
      else {
        onClose()
        router.refresh()
      }
    })
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/30 p-3">
      <div className="flex items-center justify-between">
        <div className="text-sm">
          <span className="font-medium">Move SKU</span>{" "}
          <span className="text-muted-foreground">
            {sku.sku ? <span className="tabular-nums">{sku.sku}</span> : "(no code)"}
            {" · "}
            {sku.site_name}
          </span>
        </div>
        <Button size="icon-sm" variant="ghost" aria-label="Cancel" onClick={onClose}>
          <X />
        </Button>
      </div>

      {error ? (
        <div className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          autoFocus
          value={query}
          onChange={(e) => {
            setSelected(null)
            setSearching(true)
            setQuery(e.target.value)
          }}
          placeholder="Search products by name…"
          className="pl-8"
        />
      </div>

      <div className="max-h-64 overflow-y-auto rounded-lg border border-border">
        {searching && results.length === 0 ? (
          <p className="px-3 py-2 text-sm text-muted-foreground">Searching…</p>
        ) : results.length === 0 ? (
          <p className="px-3 py-2 text-sm text-muted-foreground">
            No products match “{query}”.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {results.map((p) => {
              const isSelected = selected?.id === p.id
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => setSelected(p)}
                    className={
                      "flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-accent " +
                      (isSelected ? "bg-accent" : "")
                    }
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className="flex items-center gap-1.5 truncate font-medium">
                        {p.name}
                        {!p.is_active ? (
                          <Badge variant="muted">Inactive</Badge>
                        ) : null}
                      </span>
                      <span className="truncate text-xs text-muted-foreground">
                        {p.site_count} site{p.site_count === 1 ? "" : "s"}
                        {p.skus.length ? ` · ${p.skus.join(", ")}` : ""}
                      </span>
                    </span>
                    {isSelected ? (
                      <Check className="size-4 shrink-0 text-primary" />
                    ) : null}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          disabled={!selected || isPending}
          onClick={confirmMove}
        >
          <ArrowRightLeft data-icon="inline-start" />
          {selected ? `Move to “${selected.name}”` : "Move"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose} disabled={isPending}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
