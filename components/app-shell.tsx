"use client"

import { useState, type ReactNode } from "react"
import Link from "next/link"
import Image from "next/image"
import { Menu, X } from "lucide-react"

import { SidebarNav } from "@/components/sidebar-nav"
import { LogoutButton } from "@/components/logout-button"
import { ThemeToggle } from "@/components/theme-toggle"

function Brand() {
  return (
    <Link
      href="/dashboard"
      className="flex items-center px-5 py-4"
      aria-label="OrbisTrack"
    >
      <Image
        src="/orbistrack-wordmark.png"
        alt="OrbisTrack"
        width={560}
        height={113}
        priority
        className="h-8 w-auto"
      />
    </Link>
  )
}

export function AppShell({
  userEmail,
  banner,
  children,
}: {
  userEmail: string
  // Optional portal-wide alert bar rendered directly under the top header
  // (e.g. low packaging stock). Omitted/null renders nothing.
  banner?: ReactNode
  children: ReactNode
}) {
  const [mobileOpen, setMobileOpen] = useState(false)

  return (
    <div className="print-shell flex min-h-svh w-full">
      {/* Desktop sidebar */}
      <aside className="no-print hidden w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar md:flex">
        <Brand />
        <SidebarNav />
      </aside>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="no-print fixed inset-0 z-50 md:hidden">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setMobileOpen(false)}
            aria-hidden="true"
          />
          <aside className="absolute inset-y-0 left-0 flex w-64 flex-col border-r border-sidebar-border bg-sidebar shadow-xl">
            <div className="flex items-center justify-between pr-3">
              <Brand />
              <button
                type="button"
                onClick={() => setMobileOpen(false)}
                className="rounded-md p-2 text-muted-foreground hover:bg-sidebar-accent"
                aria-label="Close menu"
              >
                <X className="size-5" />
              </button>
            </div>
            <SidebarNav onNavigate={() => setMobileOpen(false)} />
          </aside>
        </div>
      )}

      {/* Main column */}
      <div className="print-shell flex min-w-0 flex-1 flex-col">
        <header className="no-print flex h-14 items-center gap-3 border-b px-4 md:px-6">
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            className="rounded-md p-2 text-muted-foreground hover:bg-muted md:hidden"
            aria-label="Open menu"
          >
            <Menu className="size-5" />
          </button>
          <div className="min-w-0 flex-1" />
          <span className="hidden truncate text-sm text-muted-foreground sm:inline">
            {userEmail}
          </span>
          <ThemeToggle />
          <LogoutButton />
        </header>
        {banner}
        <main className="print-shell-main flex-1 p-4 md:p-8">
          <div className="print-shell-main mx-auto w-full max-w-6xl">
            {children}
          </div>
        </main>
      </div>
    </div>
  )
}
