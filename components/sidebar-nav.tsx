"use client"

import type { ComponentType } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import {
  LayoutDashboard,
  Boxes,
  ClipboardList,
  PackageCheck,
  FolderTree,
  BarChart3,
} from "lucide-react"

import { cn } from "@/lib/utils"

export type NavItem = {
  label: string
  href: string
  icon: ComponentType<{ className?: string }>
  description: string
}

export const NAV_ITEMS: NavItem[] = [
  {
    label: "Dashboard",
    href: "/dashboard",
    icon: LayoutDashboard,
    description: "Operations overview across all sites",
  },
  {
    label: "Inventory",
    href: "/inventory",
    icon: Boxes,
    description: "On-hand, available, and reserved per SKU",
  },
  {
    label: "Orders",
    href: "/orders",
    icon: ClipboardList,
    description: "Create, edit, hold, combine, and fulfill",
  },
  {
    label: "Packing",
    href: "/packing",
    icon: PackageCheck,
    description: "Pack orders and record packaging costs",
  },
  {
    label: "Catalog",
    href: "/catalog",
    icon: FolderTree,
    description: "Products, child SKUs, and categories",
  },
  {
    label: "Reports",
    href: "/reports",
    icon: BarChart3,
    description: "Sales, inventory, packaging, and shipping",
  },
]

export function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname()

  return (
    <nav className="flex flex-col gap-1 px-3 py-2">
      {NAV_ITEMS.map((item) => {
        const active =
          pathname === item.href || pathname.startsWith(item.href + "/")
        const Icon = item.icon
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
              active
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
            )}
          >
            <Icon className="size-4 shrink-0" />
            {item.label}
          </Link>
        )
      })}
    </nav>
  )
}
