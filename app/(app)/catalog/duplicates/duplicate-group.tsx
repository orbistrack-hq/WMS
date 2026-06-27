"use client"

import { useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { AlertCircle, AlertTriangle, GitMerge } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  mergeProducts,
  previewMerge,
  type MergePreview,
} from "../actions"

export type DupProduct = {
  id: string
  name: string
  is_active: boolean
  site_count: number
  skus: string[]
}

/** Best default survivor: most sites, then active, then name. */
function defaultSurvivor(products: DupProduct[]): string {
  return [...products].sort((a, b) => {
    if (b.site_count !== a.site_count) return b.site_count - a.site_count
    if (a.is_active !== b.is_active) return a.is_active ? -1 : 1
    return a.name.localeCompare(b.name)
  })[0].id
}

/**
 * One row of duplicate_products_report: a SKU held by several master products.
 * The operator picks which one survives and merges the rest in, with the same
 * dry-run conflict preview the per-product merge tool uses.
 */
export function DuplicateGroup({
  sku,
  products,
}: {
  sku: string
  products: DupProduct[]
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const [survivorId, setSurvivorId] = useState(() => defaultSurvivor(products))
  const [preview, setPreview] = useState<MergePreview | null>(null)

  const loserIds = useMemo(
    () => products.filter((p) => p.id !== survivorId).map((p) => p.id),
    [products, survivorId],
  )

  function choose(id: string) {
    setSurvivorId(id)
    setPreview(null)
    setError(null)
  }

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
      else {
        setPreview(null)
        router.refresh()
      }
    })
  }

  const hasConflicts = (preview?.conflicts.length ?? 0) > 0
  const canMerge = preview?.ok === true && !hasConflicts

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">SKU</span>
        <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-sm tabular-nums">
          {sku}
        </span>
        <span className="text-sm text-muted-foreground">
          · {products.length} products
        </span>
      </div>

      {error ? (
        <div className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1 text-xs text-muted-foreground">
          Keep which product? The others merge into it.
        </legend>
        {products.map((p) => (
          <label
            key={p.id}
            className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-border px-3 py-2 text-sm has-[:checked]:border-primary has-[:checked]:bg-accent"
          >
            <input
              type="radio"
              name={`survivor-${sku}`}
              className="size-4 accent-primary"
              checked={survivorId === p.id}
              onChange={() => choose(p.id)}
            />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="flex items-center gap-1.5 truncate font-medium">
                <Link
                  href={`/catalog/${p.id}`}
                  className="truncate hover:underline"
                  onClick={(e) => e.stopPropagation()}
                >
                  {p.name}
                </Link>
                {survivorId === p.id ? (
                  <Badge variant="success">Survivor</Badge>
                ) : null}
                {!p.is_active ? <Badge variant="muted">Inactive</Badge> : null}
              </span>
              <span className="truncate text-xs text-muted-foreground">
                {p.site_count} site{p.site_count === 1 ? "" : "s"}
                {p.skus.length ? ` · ${p.skus.join(", ")}` : ""}
              </span>
            </span>
          </label>
        ))}
      </fieldset>

      {preview ? (
        hasConflicts ? (
          <div className="flex flex-col gap-1.5 rounded-lg bg-amber-500/10 px-3 py-2 text-sm">
            <div className="flex items-start gap-2 font-medium text-amber-700 dark:text-amber-400">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span>
                Can&apos;t auto-merge — two of these hold a SKU at the same site:
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
              Open a product and move or remove one side&apos;s SKU at each site,
              then preview again.
            </p>
          </div>
        ) : (
          <p className="rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400">
            {preview.moved} SKU{preview.moved === 1 ? "" : "s"} will move; the
            other {loserIds.length} product{loserIds.length === 1 ? "" : "s"} will
            be deactivated.
          </p>
        )
      ) : null}

      <div className="flex items-center gap-2">
        {canMerge ? (
          <Button size="sm" disabled={isPending} onClick={commit}>
            <GitMerge data-icon="inline-start" /> Merge into survivor
          </Button>
        ) : (
          <Button size="sm" disabled={isPending} onClick={runPreview}>
            Preview merge
          </Button>
        )}
      </div>
    </div>
  )
}
