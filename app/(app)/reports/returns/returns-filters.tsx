"use client"

import { useTransition } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"

import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Button } from "@/components/ui/button"

type SiteOption = { id: string; name: string }

const CHANNELS = [
  { value: "manual", label: "Manual" },
  { value: "shopify", label: "Shopify" },
  { value: "woocommerce", label: "WooCommerce" },
]

/** Date/site/channel filter for the returns report. Dates filter returned_at. */
export function ReturnsFilters({ sites }: { sites: SiteOption[] }) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const [isPending, startTransition] = useTransition()

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(params.toString())
    if (value) next.set(key, value)
    else next.delete(key)
    startTransition(() => router.replace(`${pathname}?${next.toString()}`))
  }

  const from = params.get("from") ?? ""
  const to = params.get("to") ?? ""
  const site = params.get("site") ?? ""
  const channel = params.get("channel") ?? ""
  const hasFilters = Boolean(from || to || site || channel)

  return (
    <div
      className="mb-4 flex flex-wrap items-end gap-3"
      data-pending={isPending ? "" : undefined}
    >
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Returned from
        <Input
          type="date"
          value={from}
          max={to || undefined}
          onChange={(e) => setParam("from", e.target.value)}
          className="w-40"
          aria-label="Returned from date"
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Returned to
        <Input
          type="date"
          value={to}
          min={from || undefined}
          onChange={(e) => setParam("to", e.target.value)}
          className="w-40"
          aria-label="Returned to date"
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Site
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
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Channel
        <Select
          value={channel}
          onChange={(e) => setParam("channel", e.target.value)}
          className="w-40"
          aria-label="Filter by channel"
        >
          <option value="">All channels</option>
          {CHANNELS.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </Select>
      </label>
      {hasFilters ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => startTransition(() => router.replace(pathname))}
        >
          Clear
        </Button>
      ) : null}
    </div>
  )
}
