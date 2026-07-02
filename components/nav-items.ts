import type { ComponentType } from "react"
import {
  LayoutDashboard,
  Boxes,
  PackagePlus,
  ClipboardList,
  PackageCheck,
  FolderTree,
  BarChart3,
  Store,
  ShoppingCart,
  Settings,
} from "lucide-react"

export type NavItem = {
  label: string
  href: string
  icon: ComponentType<{ className?: string }>
  description: string
}

// Shared, framework-neutral data (no "use client"): importable by both the
// client SidebarNav and server components like the dashboard. Exporting this
// from a "use client" module turns it into a client reference on the server
// side, which is why it lives here on its own.
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
    label: "Intake",
    href: "/inventory/intake",
    icon: PackagePlus,
    description: "Receive bulk and allocate to client SKUs",
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
    href: "/reports",
    icon: BarChart3,
    description: "COGS, landed margin, and sales trends",
  },
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
  {
    label: "Settings",
    href: "/settings",
    icon: Settings,
    description: "Sites, categories, and integrations",
  },
]
