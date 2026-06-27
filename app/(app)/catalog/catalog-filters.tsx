"use client"

import { useRef, useTransition } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { Search, X } from "lucide-react"

import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Combobox } from "@/components/ui/combobox"
import { Button } from "@/components/ui/button"

export type CategoryOption = { id: string; label: string }

export function CatalogFilters({
  categories,
}: {
  categories: CategoryOption[]
}) {
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
  const category = params.get("category") ?? ""
  const active = params.get("active") ?? ""
  const hasFilters = Boolean(q || category || active)

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
          placeholder="Search product name…"
          className="pl-8"
          onChange={(e) => setParam("q", e.target.value.trim())}
          aria-label="Search products"
        />
      </div>

      <Combobox
        value={category}
        onValueChange={(v) => setParam("category", v)}
        className="w-56"
        aria-label="Filter by category"
        placeholder="All categories"
        searchPlaceholder="Search categories…"
        emptyText="No matching category."
        options={[
          { value: "", label: "All categories" },
          { value: "none", label: "Uncategorized" },
          ...categories.map((c) => ({ value: c.id, label: c.label })),
        ]}
      />

      <Select
        value={active}
        onChange={(e) => setParam("active", e.target.value)}
        className="w-36"
        aria-label="Filter by active"
      >
        <option value="">Active: any</option>
        <option value="true">Active</option>
        <option value="false">Inactive</option>
      </Select>

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
