"use client"

import { useState } from "react"
import Link from "next/link"
import { Bell, X } from "lucide-react"

import type { Notifications } from "@/lib/notifications"

/**
 * Header notifications button + slide-over drawer. Shows a bell with an unread
 * count next to the user email; clicking opens a right-side drawer listing the
 * ops alert groups (low packaging stock, low stock SKUs) that used to be top
 * banners. Empty state reads "all caught up".
 */
export function NotificationsBell({ data }: { data: Notifications }) {
  const [open, setOpen] = useState(false)
  const { total, groups } = data

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="relative rounded-md p-2 text-muted-foreground hover:bg-muted"
        aria-label={
          total > 0 ? `Notifications (${total})` : "Notifications"
        }
      >
        <Bell className="size-5" />
        {total > 0 ? (
          <span className="absolute -top-0.5 -right-0.5 flex min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-4 text-white">
            {total > 99 ? "99+" : total}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="no-print fixed inset-0 z-50">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <aside
            role="dialog"
            aria-label="Notifications"
            className="absolute inset-y-0 right-0 flex w-full max-w-sm flex-col border-l border-border bg-background shadow-xl"
          >
            <div className="flex h-14 items-center justify-between border-b px-4">
              <h2 className="text-sm font-semibold">
                Notifications{total > 0 ? ` (${total})` : ""}
              </h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-md p-2 text-muted-foreground hover:bg-muted"
                aria-label="Close notifications"
              >
                <X className="size-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto">
              {groups.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
                  <Bell className="size-8 text-muted-foreground/50" />
                  <p className="text-sm text-muted-foreground">
                    You&apos;re all caught up.
                  </p>
                </div>
              ) : (
                <ul className="divide-y divide-border">
                  {groups.map((g) => (
                    <li key={g.key} className="px-4 py-3">
                      <div className="mb-2 flex items-center gap-2">
                        <span className="flex size-5 items-center justify-center rounded-full bg-destructive/10 text-[11px] font-semibold text-destructive">
                          {g.count > 99 ? "99+" : g.count}
                        </span>
                        <span className="text-sm font-semibold">{g.title}</span>
                        <Link
                          href={g.href}
                          onClick={() => setOpen(false)}
                          className="ml-auto text-xs font-medium text-primary underline-offset-2 hover:underline"
                        >
                          {g.linkLabel}
                        </Link>
                      </div>
                      <ul className="flex flex-col gap-1.5">
                        {g.items.map((it, i) => (
                          <li
                            key={i}
                            className="flex items-baseline justify-between gap-2 text-sm"
                          >
                            <span className="min-w-0 truncate">{it.label}</span>
                            {it.sub ? (
                              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                                {it.sub}
                              </span>
                            ) : null}
                          </li>
                        ))}
                        {g.count > g.items.length ? (
                          <li className="text-xs text-muted-foreground">
                            +{g.count - g.items.length} more
                          </li>
                        ) : null}
                      </ul>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </aside>
        </div>
      ) : null}
    </>
  )
}
