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

export function ReportsFilters({ sites }: { sites: SiteOption[] }) {
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
  const dim = params.get("dim") ?? "channel"
  const grain = params.get("grain") ?? "day"
  const hasFilters = Boolean(from || to || site || channel)

  return (
    <div
      className="mb-4 flex flex-wrap items-end gap-3"
      data-pending={isPending ? "" : undefined}
    >
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        From
        <Input
          type="date"
          value={from}
          max={to || undefined}
          onChange={(e) => setParam("from", e.target.value)}
          className="w-40"
          aria-label="From date"
        />
      </label>

      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        To
        <Input
          type="date"
          value={to}
          min={from || undefined}
          onChange={(e) => setParam("to", e.target.value)}
          className="w-40"
          aria-label="To date"
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

      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Trend by
        <Select
          value={grain}
          onChange={(e) => setParam("grain", e.target.value)}
          className="w-32"
          aria-label="Trend granularity"
        >
          <option value="day">Day</option>
          <option value="month">Month</option>
        </Select>
      </label>

      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Break down by
        <Select
          value={dim}
          onChange={(e) => setParam("dim", e.target.value)}
          className="w-36"
          aria-label="Breakdown dimension"
        >
          <option value="channel">Channel</option>
          <option value="site">Site</option>
        </Select>
      </label>

      {hasFilters ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            // Keep view prefs (dim/grain), clear data filters only.
            const next = new URLSearchParams()
            if (dim !== "channel") next.set("dim", dim)
            if (grain !== "day") next.set("grain", grain)
            startTransition(() =>
              router.replace(
                next.toString() ? `${pathname}?${next.toString()}` : pathname,
              ),
            )
          }}
        >
          Clear
        </Button>
      ) : null}
    </div>
  )
}
