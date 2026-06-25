import Link from "next/link"
import { CheckCircle2, XCircle, Package } from "lucide-react"
import { createClient } from "@/lib/supabase/server"
import { buttonVariants } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

export default async function Home() {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("orders")
    .select("id")
    .limit(1)
    .maybeSingle()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  const connected = !error

  return (
    <main className="flex min-h-svh w-full items-center justify-center p-6 md:p-10">
      <div className="flex w-full max-w-md flex-col gap-6">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Package className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-xl font-semibold leading-tight text-balance">
              Warehouse Management
            </h1>
            <p className="text-sm text-muted-foreground">Project foundation</p>
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Supabase Connection</CardTitle>
            <CardDescription>Live check against your database</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex items-center gap-2 rounded-md border p-3">
              {connected ? (
                <CheckCircle2 className="h-5 w-5 text-green-600" />
              ) : (
                <XCircle className="h-5 w-5 text-destructive" />
              )}
              <span className="text-sm font-medium">
                {connected ? "Connected" : "Not connected"}
              </span>
            </div>

            {connected && data?.id ? (
              <p className="text-sm text-muted-foreground">Order ID: {data.id}</p>
            ) : null}

            {error ? (
              <p className="text-sm text-destructive">{error.message}</p>
            ) : null}

            <div className="flex flex-col gap-2 pt-2">
              {user ? (
                <Link
                  href="/dashboard"
                  className={buttonVariants({ className: "w-full" })}
                >
                  Go to dashboard
                </Link>
              ) : (
                <>
                  <Link
                    href="/auth/login"
                    className={buttonVariants({ className: "w-full" })}
                  >
                    Login
                  </Link>
                  <Link
                    href="/auth/sign-up"
                    className={buttonVariants({
                      variant: "outline",
                      className: "w-full",
                    })}
                  >
                    Create account
                  </Link>
                </>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </main>
  )
}
