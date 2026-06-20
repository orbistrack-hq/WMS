import { redirect } from "next/navigation"
import { Package } from "lucide-react"
import { createClient } from "@/lib/supabase/server"
import { LogoutButton } from "@/components/logout-button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

export default async function ProtectedPage() {
  const supabase = await createClient()

  const { data, error } = await supabase.auth.getUser()
  if (error || !data?.user) {
    redirect("/auth/login")
  }

  return (
    <main className="flex min-h-svh w-full flex-col">
      <header className="flex items-center justify-between border-b px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Package className="h-5 w-5" />
          </div>
          <span className="font-semibold">Warehouse Management</span>
        </div>
        <LogoutButton />
      </header>

      <div className="flex-1 p-6 md:p-10">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
          <div>
            <h1 className="text-2xl font-semibold text-balance">Dashboard</h1>
            <p className="text-sm text-muted-foreground">
              Signed in as {data.user.email}
            </p>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Getting started</CardTitle>
              <CardDescription>
                Your authenticated foundation is ready
              </CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground leading-relaxed">
                This is your protected area. Next, we can add inventory items,
                stock locations, and other warehouse features backed by
                Supabase.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </main>
  )
}
