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
import {
  OutboundQueueCard,
  OUTBOUND_QUEUE_SELECT,
  mapOutboundJobs,
} from "@/components/outbound-queue-card"
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

export default async function ShopifyIntegrationPage() {
  const supabase = await createClient()

  const [connRes, sitesRes, importsRes, secretsRes, outboundRes, queueRes, hdrs] =
    await Promise.all([
    supabase
      .from("store_connections")
      .select(
        "id, source, site_id, is_active, last_synced_at, sync_inventory_outbound, inventory_location_id, sync_orders_since, site:sites(name)",
      )
      .eq("channel", "shopify")
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
      .eq("channel", "shopify")
      .order("received_at", { ascending: false })
      .limit(50),
    // Boolean-only view: the raw token/secret are sealed from the API role and
    // never leave the database. We only learn whether each field is set.
    supabase
      .from("store_credential_status")
      .select("connection_id, has_token, has_secret")
      .eq("channel", "shopify"),
    supabase
      .from("store_outbound_sync_status")
      .select("site_id, pending, processing, failed, skipped"),
    supabase
      .from("store_outbound_inventory_jobs")
      .select(OUTBOUND_QUEUE_SELECT)
      .in("status", ["pending", "processing", "failed"])
      .order("status")
      .order("next_attempt_at")
      .limit(500),
    headers(),
  ])

  const outboundBySite = new Map(
    (
      (outboundRes.data ?? []) as {
        site_id: string
        pending: number
        processing: number
        failed: number
        skipped: number
      }[]
    ).map((o) => [o.site_id, o]),
  )

  // Any user who can see a connection (RLS site-scoped) can manage it.
  const canManage = true
  const credByConn = new Map(
    (
      (secretsRes.data ?? []) as {
        connection_id: string
        has_token: boolean
        has_secret: boolean
      }[]
    ).map((s) => [
      s.connection_id,
      { hasToken: s.has_token, hasSecret: s.has_secret },
    ]),
  )
  const host = hdrs.get("host") ?? "your-app.vercel.app"
  const proto = host.startsWith("localhost") ? "http" : "https"
  const webhookUrl = `${proto}://${host}/api/shopify/webhooks`

  const connections: Connection[] = (
    (connRes.data ?? []) as unknown as {
      id: string
      source: string
      site_id: string
      is_active: boolean
      last_synced_at: string | null
      sync_inventory_outbound: boolean
      inventory_location_id: string | null
      sync_orders_since: string | null
      site: { name: string | null } | null
    }[]
  ).map((c) => {
    const cred = credByConn.get(c.id)
    const ob = outboundBySite.get(c.site_id)
    return {
      id: c.id,
      shop_domain: c.source,
      site_name: c.site?.name ?? "—",
      is_active: c.is_active,
      has_token: cred?.hasToken ?? false,
      has_secret: cred?.hasSecret ?? false,
      last_synced_at: c.last_synced_at,
      sync_inventory_outbound: c.sync_inventory_outbound ?? false,
      has_location: Boolean(c.inventory_location_id),
      sync_orders_since: c.sync_orders_since,
      outbound_pending: (ob?.pending ?? 0) + (ob?.processing ?? 0),
      outbound_failed: ob?.failed ?? 0,
    }
  })

  const imports = (importsRes.data ?? []) as unknown as ImportRow[]

  const shopifySiteIds = new Set(
    ((connRes.data ?? []) as { site_id: string }[]).map((c) => c.site_id),
  )
  const queueRows = mapOutboundJobs(queueRes.data, shopifySiteIds)

  return (
    <>
      <PageHeader
        title="Shopify"
        description="Import Shopify orders into the WMS in real time via webhooks."
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
              In your Shopify admin, go to{" "}
              <strong>Settings → Apps and sales channels → Develop apps</strong>{" "}
              and create a custom app.
            </p>
            <ol className="ml-4 flex list-decimal flex-col gap-1.5 text-xs text-muted-foreground marker:text-muted-foreground">
              <li>
                Under <strong>Admin API access scopes</strong>, enable{" "}
                <code className="font-mono">read_orders</code>,{" "}
                <code className="font-mono">read_products</code>, and{" "}
                <code className="font-mono">read_customers</code>, then install
                the app.
              </li>
              <li>
                Copy the <strong>Admin API access token</strong> (
                <code className="font-mono">shpat_…</code>) and the{" "}
                <strong>API secret key</strong> from the app&apos;s API
                credentials.
              </li>
              <li>
                Connect your store below, paste both into{" "}
                <strong>Add credentials</strong>, then click{" "}
                <strong>Register webhooks</strong> and <strong>Sync products</strong>.
                Syncing fills in the{" "}
                <Link href="/catalog" className="underline">
                  catalog
                </Link>{" "}
                so incoming order lines map automatically.
              </li>
            </ol>
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">
                Webhook endpoint (if you prefer to add webhooks manually)
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

        <OutboundQueueCard rows={queueRows} showSite={shopifySiteIds.size > 1} />

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
                    <TableHead>Shopify order</TableHead>
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
