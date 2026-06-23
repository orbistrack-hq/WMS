import { redirect } from "next/navigation"

import { createClient } from "@/lib/supabase/server"
import { AppShell } from "@/components/app-shell"

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = await createClient()
  const { data, error } = await supabase.auth.getUser()

  if (error || !data?.user) {
    redirect("/auth/login")
  }

  return <AppShell userEmail={data.user.email ?? ""}>{children}</AppShell>
}
