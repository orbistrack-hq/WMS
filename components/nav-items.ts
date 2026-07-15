import type { ComponentType } from "react"
import {
  LayoutDashboard,
  Boxes,
  PackagePlus,
  Package,
  ClipboardList,
  PackageCheck,
  FolderTree,
  BarChart3,
  Undo2,
  PackageX,
  Clock,
  Store,
  ShoppingCart,
  Plug,
  Settings,
} from "lucide-react"

export type NavItem = {
  label: string
  href: string
  icon: ComponentType<{ className?: string }>
  description: string
}

/** A collapsible group of nav items (e.g. Integrations). Has no href itself. */
export type NavGroup = {
  label: string
  icon: ComponentType<{ className?: string }>
  description: string
  children: NavItem[]
}

export type NavEntry = NavItem | NavGroup

export function isNavGroup(e: NavEntry): e is NavGroup {
  return (e as NavGroup).children !== undefined
}

// Shared, framework-neutral data (no "use client"): importable by both the
// client SidebarNav and server components like the dashboard.
//
// NAV_TREE is the grouped structure the sidebar renders (Shopify + WooCommerce
// live under a collapsible "Integrations" group). NAV_ITEMS is the flattened
// leaf list derived from it — the dashboard's quick links use that, so grouping
// in the sidebar never changes what the dashboard shows.
export const NAV_TREE: NavEntry[] = [
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
    label: "Intake",
    icon: PackagePlus,
    description: "Receive stock into the warehouse",
    children: [
      {
        label: "Product",
        href: "/inventory/intake",
        icon: PackagePlus,
        description: "Receive bulk and allocate to client SKUs",
      },
      {
        label: "Packaging",
        href: "/inventory/packaging",
        icon: Package,
        description: "Central packaging stock on hand — receive and adjust",
      },
    ],
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
    label: "Analytics",
    icon: BarChart3,
    description: "Sales, margin, and operational reports",
    children: [
      {
        label: "Overview",
        href: "/reports",
        icon: BarChart3,
        description: "COGS, landed margin, and sales trends",
      },
      {
        label: "Returns",
        href: "/reports/returns",
        icon: Undo2,
        description: "Bounced orders, restocked and logged per site",
      },
      {
        label: "Packaging gaps",
        href: "/reports/packaging-gaps",
        icon: PackageX,
        description: "Fulfilled store orders missing packaging costs",
      },
      {
        label: "Backorders",
        href: "/reports/backorders",
        icon: Clock,
        description: "Open orders awaiting stock — units owed per SKU",
      },
    ],
  },
  {
    label: "Integrations",
    icon: Plug,
    description: "Store connections and order sync",
    children: [
      {
        label: "Shopify",
        href: "/integrations/shopify",
        icon: Store,
        description: "Import Shopify orders via webhooks",
      },
      {
        label: "WooCommerce",
        href: "/integrations/woocommerce",
        icon: ShoppingCart,
        description: "Import WooCommerce orders via webhooks",
      },
    ],
  },
  {
    label: "Settings",
    href: "/settings",
    icon: Settings,
    description: "Sites, categories, packaging, and integrations",
  },
]

/** Flattened leaf items (groups expanded) — for the dashboard quick links. */
export const NAV_ITEMS: NavItem[] = NAV_TREE.flatMap((e) =>
  isNavGroup(e) ? e.children : [e],
)
