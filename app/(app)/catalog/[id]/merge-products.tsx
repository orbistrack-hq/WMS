"use client"

import { useEffect, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import {
  AlertCircle,
  AlertTriangle,
  Check,
  GitMerge,
  Search,
  X,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import {
  mergeProducts,
  previewMerge,
  searchProducts,
  type MergePreview,
  type ProductSearchResult,
} from "../actions"

/**
 * Merge other master products INTO this one. The survivor is always the product
 * being viewed; the operator searches and selects the duplicates to absorb. A
 * dry-run preview shows how many SKUs will move and surfaces any one-child-per-
 * site conflicts (which block the merge until resolved).
 */
export function MergeProducts({
  survivorId,
  survivorName,
}: {
  survivorId: string
  survivorName: string
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)

  if (!open) {
    return (
      <Button
        variant="outline"
        size="sm"
        className="self-start"
        onClick={() => setOpen(true)}
      >
        <GitMerge data-icon="inline-start" /> Merge another product in
      </Button>
    )
  }

  return (
    <MergePanel
      survivorId={survivorId}
      survivorName={survivorName}
      onClose={() => setOpen(false)}
      onDone={() => {
        setOpen(false)
        router.refresh()
      }}
    />
  )
}

function MergePanel({
  survivorId,
  survivorName,
  onClose,
  onDone,
}: {
  survivorId: string
  survivorName: string
  onClose: () => void
  onDone: () => void
}) {
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const [query, setQuery] = useState("")
  const [results, setResults] = useState<ProductSearchResult[]>([])
  const [searching, setSearching] = useState(false)

  // Chosen losers, keyed by id so selection survives re-searches.
  const [selected, setSelected] = useState<Map<string, ProductSearchResult>>(
    new Map(),
  )
  const [preview, setPreview] = useState<MergePreview | null>(null)

  // Debounced search; selecting/searching invalidates any stale preview.
  useEffect(() => {
    setSearching(true)
    const handle = setTimeout(async () => {
      const res = await searchProducts(query, survivorId)
      if (res.ok) setResults(res.products)
      else setError(res.error)
      setSearching(false)
    }, 200)
    return () => clearTimeout(handle)
  }, [query, survivorId])

  function toggle(p: ProductSearchResult) {
    setPreview(null)
    setSelected((prev) => {
      const next = new Map(prev)
      if (next.has(p.id)) next.delete(p.id)
      else next.set(p.id, p)
      return next
    })
  }

  const loserIds = [...selected.keys()]

  function runPreview() {
    setError(null)
    startTransition(async () => {
      const res = await previewMerge(survivorId, loserIds)
      if (!res.ok) setError(res.error)
      else setPreview(res.preview)
    })
  }

  function commit() {
    setError(null)
    startTransition(async () => {
      const res = await mergeProducts(survivorId, loserIds)
      if (!res.ok) setError(res.error)
      else onDone()
    })
  }

  const hasConflicts = (preview?.conflicts.length ?? 0) > 0
  const canMerge = preview?.ok === true && !hasConflicts && loserIds.length > 0

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/30 p-3">
      <div className="flex items-center justify-between">
        <p className="text-sm">
          Merge products into{" "}
          <span className="font-medium">{survivorName}</span>
        </p>
        <Button size="icon-sm" variant="ghost" aria-label="Close" onClick={onClose}>
          <X />
        </Button>
      </div>

      {error ? (
        <div className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      {/* Selected losers */}
      {selected.size > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {[...selected.values()].map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => toggle(p)}
              className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 text-xs hover:bg-accent"
            >
              {p.name}
              <X className="size-3" />
            </button>
          ))}
        </div>
      ) : null}

      {/* Search */}
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search products to merge in…"
          className="pl-8"
        />
      </div>

      <div className="max-h-56 overflow-y-auto rounded-lg border border-border">
        {searching && results.length === 0 ? (
          <p className="px-3 py-2 text-sm text-muted-foreground">Searching…</p>
        ) : results.length === 0 ? (
          <p className="px-3 py-2 text-sm text-muted-foreground">
            No products match “{query}”.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {results.map((p) => {
              const isSelected = selected.has(p.id)
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => toggle(p)}
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

      {/* Preview result */}
      {preview ? (
        hasConflicts ? (
          <div className="flex flex-col gap-1.5 rounded-lg bg-amber-500/10 px-3 py-2 text-sm">
            <div className="flex items-start gap-2 font-medium text-amber-700 dark:text-amber-400">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span>
                Resolve these site conflicts first — both products hold a SKU at
                the same site:
              </span>
            </div>
            <ul className="ml-6 list-disc text-muted-foreground">
              {preview.conflicts.map((c) => (
                <li key={c.site_id}>
                  {c.site_name ?? "Unknown site"}
                  {c.skus.length ? ` (${c.skus.join(", ")})` : ""}
                </li>
              ))}
            </ul>
            <p className="ml-6 text-xs text-muted-foreground">
              Move or remove one side&apos;s SKU at each site, then preview again.
            </p>
          </div>
        ) : (
          <p className="rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400">
            {preview.moved} SKU{preview.moved === 1 ? "" : "s"} will move onto{" "}
            {survivorName}; {loserIds.length} product
            {loserIds.length === 1 ? "" : "s"} will be deactivated.
          </p>
        )
      ) : null}

      {/* Actions */}
      <div className="flex items-center gap-2">
        {!preview || hasConflicts ? (
          <Button
            size="sm"
            disabled={loserIds.length === 0 || isPending}
            onClick={runPreview}
          >
            Preview merge
          </Button>
        ) : (
          <Button size="sm" disabled={!canMerge || isPending} onClick={commit}>
            <GitMerge data-icon="inline-start" />
            Merge {loserIds.length} product{loserIds.length === 1 ? "" : "s"} in
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onClose} disabled={isPending}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
