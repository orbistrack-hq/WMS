import Link from "next/link"
import { Building2, FolderTree, Store, UserCircle } from "lucide-react"

import { createClient } from "@/lib/supabase/server"
import { PageHeader } from "@/components/page-header"
import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

export const dynamic = "force-dynamic"

const ROLE_LABEL: Record<string, string> = {
  admin: "Admin",
  operator: "Operator",
  client: "Client",
}

export default async function SettingsPage() {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name, role")
    .eq("id", user?.id ?? "")
    .maybeSingle()

  const role = (profile?.role as string) ?? "operator"

  const sections = [
    {
      title: "Sites",
      description: "Warehouses and locations. Everything is scoped per site.",
      href: "/settings/sites",
      icon: Building2,
      adminOnly: true,
    },
    {
      title: "Categories",
      description: "The multi-level product category tree.",
      href: "/catalog/categories",
      icon: FolderTree,
      adminOnly: true,
    },
    {
      title: "Shopify",
      description: "Connect stores, sync products, and import orders.",
      href: "/integrations/shopify",
      icon: Store,
      adminOnly: false,
    },
  ]

  return (
    <>
      <PageHeader
        title="Settings"
        description="Configuration and integrations."
      />

      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <UserCircle className="size-4 text-muted-foreground" /> Account
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm">
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">Name</span>
              <span>{profile?.full_name ?? "—"}</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">Email</span>
              <span>{user?.email ?? "—"}</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">Role</span>
              <Badge variant={role === "admin" ? "info" : "secondary"}>
                {ROLE_LABEL[role] ?? role}
              </Badge>
            </div>
          </CardContent>
        </Card>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {sections.map((s) => {
            const Icon = s.icon
            return (
              <Link key={s.href} href={s.href} className="group">
                <Card className="h-full transition hover:ring-foreground/25">
                  <CardHeader>
                    <div className="mb-2 flex size-9 items-center justify-center rounded-md bg-muted text-foreground">
                      <Icon className="size-4" />
                    </div>
                    <CardTitle className="flex items-center gap-2 text-base">
                      {s.title}
                      {s.adminOnly ? (
                        <Badge variant="muted">Admin</Badge>
                      ) : null}
                    </CardTitle>
                    <CardDescription>{s.description}</CardDescription>
                  </CardHeader>
                </Card>
              </Link>
            )
          })}
        </div>
      </div>
    </>
  )
}
