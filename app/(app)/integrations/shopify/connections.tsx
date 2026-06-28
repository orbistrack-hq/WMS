"use client"

import { useState, useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import {
  AlertCircle,
  Check,
  KeyRound,
  Plus,
  Power,
  RefreshCw,
  ShoppingBag,
  Trash2,
  Webhook,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select } from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { formatDateTime } from "@/lib/format"
import {
  createConnection,
  deleteConnection,
  registerWebhooks,
  setConnectionActive,
  setCredentials,
  syncPastOrders,
  syncProducts,
} from "./actions"

type SiteOption = { id: string; name: string }
export type Connection = {
  id: string
  shop_domain: string
  site_name: string
  is_active: boolean
  has_token: boolean
  has_secret: boolean
  last_synced_at: string | null
}

export function Connections({
  connections,
  sites,
  canManage,
}: {
  connections: Connection[]
  sites: SiteOption[]
  canManage: boolean
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [domain, setDomain] = useState("")
  const [siteId, setSiteId] = useState(sites[0]?.id ?? "")

  function add() {
    if (!domain.trim()) {
      setError("Enter the store domain.")
      return
    }
    setError(null)
    startTransition(async () => {
      const res = await createConnection(domain, siteId)
      if (!res.ok) setError(res.error)
      else {
        setDomain("")
        router.refresh()
      }
    })
  }

  return (
    <div className="flex flex-col gap-3">
      {error ? (
        <div className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      {connections.length === 0 ? (
        <p className="text-sm text-muted-foreground">No stores connected yet.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {connections.map((c) => (
            <ConnectionCard key={c.id} conn={c} canManage={canManage} />
          ))}
        </div>
      )}

      {canManage && sites.length > 0 ? (
        <div className="flex flex-wrap items-end gap-2 rounded-lg border border-border p-3">
          <div className="flex min-w-48 flex-1 flex-col gap-1">
            <Label className="text-xs">Store domain</Label>
            <Input
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="my-store.myshopify.com"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs">WMS site</Label>
            <Select
              value={siteId}
              onChange={(e) => setSiteId(e.target.value)}
              className="w-44"
            >
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </div>
          <Button onClick={add} disabled={isPending}>
            <Plus data-icon="inline-start" /> Connect
          </Button>
        </div>
      ) : sites.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No sites yet — add one in{" "}
          <Link href="/settings/sites" className="underline">
            Sites
          </Link>{" "}
          first, then connect a store to it.
        </p>
      ) : null}
    </div>
  )
}

function ConnectionCard({
  conn,
  canManage,
}: {
  conn: Connection
  canManage: boolean
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [credOpen, setCredOpen] = useState(false)
  const [token, setToken] = useState("")
  const [secret, setSecret] = useState("")

  function run(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null)
    setNote(null)
    startTransition(async () => {
      const res = await fn()
      if (!res.ok) setError(res.error ?? "Something went wrong.")
      else router.refresh()
    })
  }

  function saveCreds() {
    if (!token.trim() && !secret.trim()) return
    setError(null)
    startTransition(async () => {
      const res = await setCredentials(conn.id, token, secret)
      if (!res.ok) setError(res.error)
      else {
        setToken("")
        setSecret("")
        setCredOpen(false)
        router.refresh()
      }
    })
  }

  function sync() {
    setError(null)
    setNote(null)
    startTransition(async () => {
      const res = await syncProducts(conn.id)
      if (!res.ok) setError(res.error)
      else {
        setNote(
          `Synced ${res.products} product${res.products === 1 ? "" : "s"}: ${res.created} new, ${res.updated} updated${res.skipped ? `, ${res.skipped} skipped` : ""}. ` +
            `Stock updated on ${res.stockSynced}, cost seeded on ${res.costSeeded}.` +
            (res.warning ? ` Note: ${res.warning}` : ""),
        )
        router.refresh()
      }
    })
  }

  function syncOrders() {
    setError(null)
    setNote(null)
    startTransition(async () => {
      const res = await syncPastOrders(conn.id)
      if (!res.ok) setError(res.error)
      else {
        setNote(
          `Past orders: ${res.imported} imported, ${res.duplicates} already imported` +
            (res.needsMapping
              ? `, ${res.needsMapping} need product mapping`
              : "") +
            (res.skipped ? `, ${res.skipped} skipped` : "") +
            ` (of ${res.fetched} fetched).` +
            (res.firstError ? ` Note: ${res.firstError}` : ""),
        )
        router.refresh()
      }
    })
  }

  function register() {
    setError(null)
    setNote(null)
    startTransition(async () => {
      const res = await registerWebhooks(conn.id)
      if (!res.ok) setError(res.error)
      else {
        setNote(
          `Webhooks: ${res.created} created, ${res.existing} already set${res.failed ? `, ${res.failed} failed` : ""}.`,
        )
        router.refresh()
      }
    })
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-medium">
            {conn.shop_domain}
          </span>
          <span className="text-xs text-muted-foreground">
            → {conn.site_name}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          {conn.is_active ? (
            <Badge variant="success">Active</Badge>
          ) : (
            <Badge variant="muted">Paused</Badge>
          )}
          {canManage ? (
            <>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={conn.is_active ? "Pause" : "Activate"}
                disabled={isPending}
                onClick={() =>
                  run(() => setConnectionActive(conn.id, !conn.is_active))
                }
              >
                <Power />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Remove"
                disabled={isPending}
                onClick={() => {
                  if (confirm(`Disconnect ${conn.shop_domain}?`))
                    run(() => deleteConnection(conn.id))
                }}
              >
                <Trash2 />
              </Button>
            </>
          ) : null}
        </div>
      </div>

      {canManage ? (
        <div className="flex flex-wrap items-center gap-2 border-t pt-2">
          <Badge variant={conn.has_token ? "success" : "warning"}>
            <KeyRound /> {conn.has_token ? "Token" : "No token"}
          </Badge>
          <Badge variant={conn.has_secret ? "success" : "warning"}>
            <KeyRound /> {conn.has_secret ? "API secret" : "No secret"}
          </Badge>
          <Button
            size="sm"
            variant="outline"
            disabled={isPending}
            onClick={() => setCredOpen((v) => !v)}
          >
            {conn.has_token || conn.has_secret
              ? "Update credentials"
              : "Add credentials"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={isPending || !conn.has_token}
            onClick={register}
          >
            <Webhook data-icon="inline-start" /> Register webhooks
          </Button>
          <Button
            size="sm"
            disabled={isPending || !conn.has_token}
            onClick={sync}
          >
            <RefreshCw data-icon="inline-start" /> Sync products
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={isPending || !conn.has_token}
            onClick={syncOrders}
          >
            <ShoppingBag data-icon="inline-start" /> Sync past orders
          </Button>
          <span className="text-xs text-muted-foreground">
            {conn.last_synced_at
              ? `Last synced ${formatDateTime(conn.last_synced_at)}`
              : "Never synced"}
          </span>
        </div>
      ) : null}

      {credOpen ? (
        <div className="flex flex-col gap-2 rounded-lg bg-muted/40 p-2.5">
          <div className="flex flex-col gap-1">
            <Label className="text-xs">Admin API access token</Label>
            <Input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={conn.has_token ? "•••• (leave blank to keep)" : "shpat_…"}
              autoComplete="off"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs">API secret key</Label>
            <Input
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={
                conn.has_secret ? "•••• (leave blank to keep)" : "shpss_…"
              }
              autoComplete="off"
            />
          </div>
          <div>
            <Button
              size="sm"
              onClick={saveCreds}
              disabled={isPending || (!token.trim() && !secret.trim())}
            >
              Save credentials
            </Button>
          </div>
        </div>
      ) : null}

      {error ? (
        <div className="flex items-start gap-2 rounded-lg bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">
          <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}
      {note ? (
        <div className="flex items-center gap-1.5 text-xs text-emerald-600">
          <Check className="size-3.5" /> {note}
        </div>
      ) : null}
    </div>
  )
}
