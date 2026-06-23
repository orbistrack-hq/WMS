import Link from "next/link"

import { PageHeader } from "@/components/page-header"
import { NAV_ITEMS } from "@/components/sidebar-nav"
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

export default function DashboardPage() {
  const sections = NAV_ITEMS.filter((item) => item.href !== "/dashboard")

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Operations overview. Live metrics appear here as each module is wired up."
      />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {sections.map((section) => {
          const Icon = section.icon
          return (
            <Link key={section.href} href={section.href} className="group">
              <Card className="h-full transition hover:ring-foreground/25">
                <CardHeader>
                  <div className="mb-2 flex size-9 items-center justify-center rounded-md bg-muted text-foreground">
                    <Icon className="size-4" />
                  </div>
                  <CardTitle className="text-base">{section.label}</CardTitle>
                  <CardDescription>{section.description}</CardDescription>
                </CardHeader>
              </Card>
            </Link>
          )
        })}
      </div>
    </>
  )
}
