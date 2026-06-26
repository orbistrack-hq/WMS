"use client"

import { useRef, useTransition } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { Search, X } from "lucide-react"

import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Button } from "@/components/ui/button"
import {
  ORDER_CHANNELS,
  ORDER_STATUSES,
  CHANNEL_LABEL,
  STATUS_BADGE,
} from "@/lib/orders/types"

type SiteOption = { id: string; name: string }

export function OrdersFilters({ sites }: { sites: SiteOption[] }) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const [isPending, startTransition] = useTransition()
  const searchRef = useRef<HTMLInputElement>(null)

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(params.toString())
    if (value) next.set(key, value)
    else next.delete(key)
    startTransition(() => {
      router.replace(`${pathname}?${next.toString()}`)
    })
  }

  const q = params.get("q") ?? ""
  const status = params.get("status") ?? ""
  const site = params.get("site") ?? ""
  const channel = params.get("channel") ?? ""
  const hold = params.get("hold") ?? ""
  const sort = params.get("sort") ?? "entered_at"
  const dir = params.get("dir") ?? "desc"
  const hasFilters = Boolean(
    q || status || site || channel || hold || params.get("sort") || params.get("dir"),
  )

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
          placeholder="Search order number…"
          className="pl-8"
          onChange={(e) => setParam("q", e.target.value.trim())}
          aria-label="Search orders"
        />
      </div>

      <Select
        value={status}
        onChange={(e) => setParam("status", e.target.value)}
        className="w-40"
        aria-label="Filter by status"
      >
        <option value="">All statuses</option>
        {ORDER_STATUSES.map((s) => (
          <option key={s} value={s}>
            {STATUS_BADGE[s].label}
          </option>
        ))}
      </Select>

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

      <Select
        value={channel}
        onChange={(e) => setParam("channel", e.target.value)}
        className="w-40"
        aria-label="Filter by channel"
      >
        <option value="">All channels</option>
        {ORDER_CHANNELS.map((c) => (
          <option key={c} value={c}>
            {CHANNEL_LABEL[c]}
          </option>
        ))}
      </Select>

      <Select
        value={hold}
        onChange={(e) => setParam("hold", e.target.value)}
        className="w-36"
        aria-label="Filter by hold"
      >
        <option value="">Hold: any</option>
        <option value="true">On hold</option>
        <option value="false">Not held</option>
      </Select>

      <Select
        value={sort}
        onChange={(e) => setParam("sort", e.target.value)}
        className="w-44"
        aria-label="Sort by"
      >
        <option value="entered_at">Sort: Date entered</option>
        <option value="sale_date">Sort: Sale date</option>
        <option value="order_number">Sort: Order #</option>
        <option value="status">Sort: Status</option>
        <option value="total">Sort: Total</option>
        <option value="items">Sort: Items</option>
      </Select>

      <Select
        value={dir}
        onChange={(e) => setParam("dir", e.target.value)}
        className="w-36"
        aria-label="Sort direction"
      >
        <option value="desc">Descending</option>
        <option value="asc">Ascending</option>
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
