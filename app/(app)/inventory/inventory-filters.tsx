"use client"

import { useRef, useTransition } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { Search, X } from "lucide-react"

import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Button } from "@/components/ui/button"

type SiteOption = { id: string; name: string }

export function InventoryFilters({ sites }: { sites: SiteOption[] }) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const [isPending, startTransition] = useTransition()
  const searchRef = useRef<HTMLInputElement>(null)

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(params.toString())
    if (value) next.set(key, value)
    else next.delete(key)
    startTransition(() => router.replace(`${pathname}?${next.toString()}`))
  }

  const q = params.get("q") ?? ""
  const site = params.get("site") ?? ""
  const hideZero = params.get("hideZero") === "1"
  const lowStock = params.get("lowStock") === "1"
  const hasFilters = Boolean(q || site || hideZero || lowStock)

  return (
    <div
      className="mb-4 flex flex-wrap items-center gap-2"
      data-pending={isPending ? "" : undefined}
    >
      <div className="relative min-w-48 flex-1">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={searchRef}
          defaultValue={q}
          placeholder="Search product or SKU…"
          className="pl-8"
          onChange={(e) => setParam("q", e.target.value.trim())}
          aria-label="Search inventory"
        />
      </div>

      <Select
        value={site}
        onChange={(e) => setParam("site", e.target.value)}
        className="w-44"
        aria-label="Filter by site"
      >
        <option value="">All sites</option>
        {sites.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </Select>

      <label className="flex items-center gap-2 rounded-lg border border-input px-2.5 py-1.5 text-sm">
        <input
          type="checkbox"
          className="size-4 accent-primary"
          checked={hideZero}
          onChange={(e) => setParam("hideZero", e.target.checked ? "1" : "")}
        />
        Hide zero stock
      </label>

      <label className="flex items-center gap-2 rounded-lg border border-input px-2.5 py-1.5 text-sm">
        <input
          type="checkbox"
          className="size-4 accent-primary"
          checked={lowStock}
          onChange={(e) => setParam("lowStock", e.target.checked ? "1" : "")}
        />
        Low stock only
      </label>

      {hasFilters ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            if (searchRef.current) searchRef.current.value = ""
            startTransition(() => router.replace(pathname))
          }}
        >
          <X /> Clear
        </Button>
      ) : null}
    </div>
  )
}
