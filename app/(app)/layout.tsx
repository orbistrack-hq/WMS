import { redirect } from "next/navigation"

import { createClient } from "@/lib/supabase/server"
import { AppShell } from "@/components/app-shell"
import { PackagingLowStockBanner } from "@/components/packaging-low-stock-banner"
import { LowStockBanner } from "@/components/low-stock-banner"

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = await createClient()
  // Verify the JWT locally (no Auth-server round-trip when asymmetric signing
  // keys are enabled). Middleware has already gated this route, so this is the
  // identity lookup for the shell, not a second network validation.
  const { data, error } = await supabase.auth.getClaims()

  if (error || !data?.claims) {
    redirect("/auth/login")
  }

  const email = typeof data.claims.email === "string" ? data.claims.email : ""

  return (
    <AppShell
      userEmail={email}
      banner={
        <>
          <PackagingLowStockBanner />
          <LowStockBanner />
        </>
      }
    >
      {children}
    </AppShell>
  )
}
