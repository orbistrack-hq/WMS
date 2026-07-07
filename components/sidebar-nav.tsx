"use client"

import { useState } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { ChevronDown } from "lucide-react"

import { cn } from "@/lib/utils"
import { NAV_TREE, isNavGroup, type NavItem } from "@/components/nav-items"

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(href + "/")
}

function NavLink({
  item,
  pathname,
  onNavigate,
  nested = false,
}: {
  item: NavItem
  pathname: string
  onNavigate?: () => void
  nested?: boolean
}) {
  const active = isActive(pathname, item.href)
  const Icon = item.icon
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
        nested && "py-1.5",
        active
          ? "bg-sidebar-accent text-sidebar-accent-foreground font-semibold shadow-[inset_3px_0_0_var(--sidebar-primary)]"
          : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
      )}
    >
      <Icon className="size-4 shrink-0" />
      {item.label}
    </Link>
  )
}

export function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname()

  return (
    <nav className="flex flex-col gap-1 px-3 py-2">
      {NAV_TREE.map((entry) => {
        if (!isNavGroup(entry)) {
          return (
            <NavLink
              key={entry.href}
              item={entry}
              pathname={pathname}
              onNavigate={onNavigate}
            />
          )
        }

        const hasActiveChild = entry.children.some((c) =>
          isActive(pathname, c.href),
        )
        return (
          <NavGroupItem
            key={entry.label}
            label={entry.label}
            icon={entry.icon}
            hasActiveChild={hasActiveChild}
          >
            {entry.children.map((c) => (
              <NavLink
                key={c.href}
                item={c}
                pathname={pathname}
                onNavigate={onNavigate}
                nested
              />
            ))}
          </NavGroupItem>
        )
      })}
    </nav>
  )
}

function NavGroupItem({
  label,
  icon: Icon,
  hasActiveChild,
  children,
}: {
  label: string
  icon: NavItem["icon"]
  hasActiveChild: boolean
  children: React.ReactNode
}) {
  // Open by default when one of its pages is active.
  const [open, setOpen] = useState(hasActiveChild)

  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={cn(
          "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
          hasActiveChild
            ? "text-sidebar-accent-foreground"
            : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
        )}
      >
        <Icon className="size-4 shrink-0" />
        <span className="flex-1 text-left">{label}</span>
        <ChevronDown
          className={cn(
            "size-4 shrink-0 transition-transform",
            open && "rotate-180",
          )}
        />
      </button>
      {open ? <div className="mt-1 flex flex-col gap-1 pl-4">{children}</div> : null}
    </div>
  )
}
