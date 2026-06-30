import Link from "next/link"
import { headers } from "next/headers"

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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { formatDateTime } from "@/lib/format"
import { Connections, type Connection } from "./connections"

export const dynamic = "force-dynamic"

type BadgeVariant =
  | "success"
  | "warning"
  | "destructive"
  | "muted"
  | "secondary"

const IMPORT_BADGE: Record<string, { label: string; variant: BadgeVariant }> = {
  received: { label: "Received", variant: "secondary" },
  imported: { label: "Imported", variant: "success" },
  needs_mapping: { label: "Needs mapping", variant: "warning" },
  error: { label: "Error", variant: "destructive" },
  skipped: { label: "Skipped", variant: "muted" },
  duplicate: { label: "Duplicate", variant: "muted" },
}

type ImportRow = {
  id: string
  source: string
  external_order_id: string
  status: string
  error: string | null
  wms_order_id: string | null
  received_at: string
}

export default async function WooCommerceIntegrationPage() {
  const supabase = await createClient()

  const [connRes, sitesRes, importsRes, secretsRes, hdrs] = await Promise.all([
    supabase
      .from("store_connections")
      .select("id, source, is_active, last_synced_at, site:sites(name)")
      .eq("channel", "woocommerce")
      .order("source"),
    supabase
      .from("sites")
      .select("id, name")
      .eq("is_active", true)
      .order("name"),
    supabase
      .from("store_order_imports")
      .select(
        "id, source, external_order_id, status, error, wms_order_id, received_at",
      )
      .eq("channel", "woocommerce")
      .order("received_at", { ascending: false })
      .limit(50),
    // Boolean-only view: raw credentials are sealed from the API role.
    supabase
      .from("store_credential_status")
      .select(
        "connection_id, has_consumer_key, has_consumer_secret, has_webhook_secret",
      )
      .eq("channel", "woocommerce"),
    headers(),
  ])

  const canManage = true
  const credByConn = new Map(
    (
      (secretsRes.data ?? []) as {
        connection_id: string
        has_consumer_key: boolean
        has_consumer_secret: boolean
        has_webhook_secret: boolean
      }[]
    ).map((s) => [s.connection_id, s]),
  )
  const host = hdrs.get("host") ?? "your-app.vercel.app"
  const proto = host.startsWith("localhost") ? "http" : "https"
  const webhookUrl = `${proto}://${host}/api/woocommerce/webhooks`

  const connections: Connection[] = (
    (connRes.data ?? []) as unknown as {
      id: string
      source: string
      is_active: boolean
      last_synced_at: string | null
      site: { name: string | null } | null
    }[]
  ).map((c) => {
    const cred = credByConn.get(c.id)
    return {
      id: c.id,
      source: c.source,
      site_name: c.site?.name ?? "—",
      is_active: c.is_active,
      has_consumer_key: cred?.has_consumer_key ?? false,
      has_consumer_secret: cred?.has_consumer_secret ?? false,
      has_webhook_secret: cred?.has_webhook_secret ?? false,
      last_synced_at: c.last_synced_at,
    }
  })

  const imports = (importsRes.data ?? []) as unknown as ImportRow[]

  return (
    <>
      <PageHeader
        title="WooCommerce"
        description="Import WooCommerce orders into the WMS in real time via webhooks."
      />

      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Setup</CardTitle>
            <CardDescription>
              One-time configuration to start receiving orders.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2.5 text-sm">
            <p className="text-xs text-muted-foreground">
              In your WordPress admin, go to{" "}
              <strong>
                WooCommerce → Settings → Advanced → REST API
              </strong>{" "}
              and add a key.
            </p>
            <ol className="ml-4 flex list-decimal flex-col gap-1.5 text-xs text-muted-foreground marker:text-muted-foreground">
              <li>
                Create an API key with <strong>Read/Write</strong> permissions
                and copy the <strong>Consumer key</strong> (
                <code className="font-mono">ck_…</code>) and{" "}
                <strong>Consumer secret</strong> (
                <code className="font-mono">cs_…</code>).
              </li>
              <li>
                Connect your store below, paste the keys plus a{" "}
                <strong>webhook secret</strong> of your choosing into{" "}
                <strong>Add credentials</strong>.
              </li>
              <li>
                Click <strong>Register webhooks</strong> and{" "}
                <strong>Sync products</strong>. Syncing fills in the{" "}
                <Link href="/catalog" className="underline">
                  catalog
                </Link>{" "}
                (including each variation of variable products) so incoming order
                lines map automatically.
              </li>
            </ol>
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">
                Webhook endpoint (if you prefer to add webhooks manually, set the
                same secret on each)
              </span>
              <code className="rounded-md bg-muted px-2 py-1.5 font-mono text-xs break-all">
                {webhookUrl}
              </code>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Connected stores</CardTitle>
            <CardDescription>
              Each store maps to the WMS site whose stock and SKUs it draws from.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Connections
              connections={connections}
              sites={sitesRes.data ?? []}
              canManage={canManage}
            />
          </CardContent>
        </Card>

        <Card className="p-0">
          <CardHeader className="p-(--card-spacing)">
            <CardTitle className="text-base">Recent imports</CardTitle>
            <CardDescription>
              The latest 50 webhook deliveries and how they resolved.
            </CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            {imports.length === 0 ? (
              <p className="px-4 pb-2 text-sm text-muted-foreground">
                No orders received yet. Once a store is connected and a test
                order is placed, deliveries appear here.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Received</TableHead>
                    <TableHead>Store</TableHead>
                    <TableHead>Woo order</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Detail</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {imports.map((im) => {
                    const badge =
                      IMPORT_BADGE[im.status] ?? {
                        label: im.status,
                        variant: "muted" as BadgeVariant,
                      }
                    return (
                      <TableRow key={im.id}>
                        <TableCell className="whitespace-nowrap text-muted-foreground">
                          {formatDateTime(im.received_at)}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {im.source}
                        </TableCell>
                        <TableCell className="font-medium">
                          {im.external_order_id}
                        </TableCell>
                        <TableCell>
                          <Badge variant={badge.variant}>{badge.label}</Badge>
                        </TableCell>
                        <TableCell className="max-w-72 truncate text-muted-foreground">
                          {im.wms_order_id ? (
                            <Link
                              href={`/orders/${im.wms_order_id}`}
                              className="underline"
                            >
                              View WMS order
                            </Link>
                          ) : (
                            (im.error ?? "—")
                          )}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  )
}
