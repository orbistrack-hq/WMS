import Link from "next/link"
import {
  ClipboardList,
  PackageCheck,
  Truck,
  CircleCheck,
  TriangleAlert,
  Wallet,
} from "lucide-react"

import { createClient } from "@/lib/supabase/server"
import { PageHeader } from "@/components/page-header"
import { NAV_ITEMS } from "@/components/nav-items"
import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { STATUS_BADGE, type OrderStatus } from "@/lib/orders/types"
import { formatCurrency, formatDate, todayISODate } from "@/lib/format"

export const dynamic = "force-dynamic"

type RecentOrder = {
  id: string
  order_number: string
  status: OrderStatus
  sale_date: string
  customer: { name: string | null } | null
}

export default async function DashboardPage() {
  const supabase = await createClient()
  const today = todayISODate()

  const baseOrders = () =>
    supabase.from("orders").select("id", { count: "exact", head: true })

  const [
    openRes,
    packingRes,
    awaitingRes,
    fulfilledRes,
    holdRes,
    oosRes,
    invValueRes,
    recentRes,
  ] = await Promise.all([
    baseOrders().in("status", ["created", "picking", "packed"]),
    baseOrders().in("status", ["created", "picking"]),
    baseOrders().eq("status", "packed"),
    baseOrders().eq("status", "fulfilled").gte("fulfilled_at", today),
    baseOrders().eq("on_hold", true).in("status", ["created", "picking", "packed"]),
    supabase
      .from("inventory_levels")
      .select("child_sku_id", { count: "exact", head: true })
      .lte("available", 0),
    supabase.from("inventory_report").select("value_at_cost").limit(5000),
    supabase
      .from("orders")
      .select("id, order_number, status, sale_date, customer:customers(name)")
      .order("entered_at", { ascending: false })
      .limit(6),
  ])

  const inventoryValue = (
    (invValueRes.data ?? []) as { value_at_cost: number | string }[]
  ).reduce((sum, r) => sum + Number(r.value_at_cost), 0)

  const recent = (recentRes.data ?? []) as unknown as RecentOrder[]

  const tiles = [
    {
      label: "Open orders",
      value: openRes.count ?? 0,
      icon: ClipboardList,
      href: "/orders",
      tone: "",
    },
    {
      label: "Needs packing",
      value: packingRes.count ?? 0,
      icon: PackageCheck,
      href: "/packing",
      tone: "text-amber-600 dark:text-amber-400",
    },
    {
      label: "Awaiting fulfillment",
      value: awaitingRes.count ?? 0,
      icon: Truck,
      href: "/orders?status=packed",
      tone: "",
    },
    {
      label: "Fulfilled today",
      value: fulfilledRes.count ?? 0,
      icon: CircleCheck,
      href: "/orders?status=fulfilled",
      tone: "text-emerald-600 dark:text-emerald-400",
    },
    {
      label: "Out of stock",
      value: oosRes.count ?? 0,
      icon: TriangleAlert,
      href: "/inventory",
      tone: (oosRes.count ?? 0) > 0 ? "text-destructive" : "",
    },
    {
      label: "Inventory value",
      value: formatCurrency(inventoryValue),
      icon: Wallet,
      href: "/inventory",
      tone: "",
    },
  ]

  const quickLinks = NAV_ITEMS.filter((i) => i.href !== "/dashboard")

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Operations overview across all sites."
      />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-3">
        {tiles.map((t) => {
          const Icon = t.icon
          return (
            <Link key={t.label} href={t.href} className="group">
              <Card className="h-full transition hover:ring-foreground/25">
                <CardContent className="flex items-center justify-between gap-3">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-xs text-muted-foreground">
                      {t.label}
                    </span>
                    <span
                      className={`text-2xl font-semibold tabular-nums ${t.tone}`}
                    >
                      {t.value}
                    </span>
                  </div>
                  <div className="flex size-9 items-center justify-center rounded-md bg-muted text-muted-foreground">
                    <Icon className="size-4" />
                  </div>
                </CardContent>
              </Card>
            </Link>
          )
        })}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Recent orders</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col">
            {recent.length === 0 ? (
              <p className="py-4 text-sm text-muted-foreground">
                No orders yet.{" "}
                <Link href="/orders/new" className="underline">
                  Create one
                </Link>
                .
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {recent.map((o) => {
                  const badge = STATUS_BADGE[o.status]
                  return (
                    <li key={o.id}>
                      <Link
                        href={`/orders/${o.id}`}
                        className="flex items-center justify-between gap-2 py-2.5 text-sm hover:bg-muted/40"
                      >
                        <span className="flex items-center gap-2">
                          <span className="font-medium">{o.order_number}</span>
                          <Badge variant={badge.variant}>{badge.label}</Badge>
                        </span>
                        <span className="flex items-center gap-3 text-muted-foreground">
                          <span className="hidden sm:inline">
                            {o.customer?.name ?? "—"}
                          </span>
                          <span>{formatDate(o.sale_date)}</span>
                        </span>
                      </Link>
                    </li>
                  )
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Jump to</CardTitle>
            <CardDescription>Modules</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-1">
            {quickLinks.map((item) => {
              const Icon = item.icon
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className="flex items-center gap-2.5 rounded-lg px-2 py-2 text-sm hover:bg-muted"
                >
                  <span className="flex size-7 items-center justify-center rounded-md bg-muted text-muted-foreground">
                    <Icon className="size-3.5" />
                  </span>
                  {item.label}
                </Link>
              )
            })}
          </CardContent>
        </Card>
      </div>
    </>
  )
}
