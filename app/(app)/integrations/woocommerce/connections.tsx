"use client"

import { useState, useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import {
  AlertCircle,
  ArrowUpFromLine,
  Check,
  KeyRound,
  Plus,
  Power,
  RefreshCw,
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
  runOutboundDrainNow,
  setConnectionActive,
  setCredentials,
  setInventoryOutbound,
  setSyncOrdersSince,
  startOrderImport,
  stepOrderImport,
  cancelOrderImport,
  syncProducts,
} from "./actions"
import { StoreImportRunner } from "@/components/store-import-runner"

type SiteOption = { id: string; name: string }
export type Connection = {
  id: string
  source: string
  site_name: string
  is_active: boolean
  has_consumer_key: boolean
  has_consumer_secret: boolean
  has_webhook_secret: boolean
  last_synced_at: string | null
  sync_inventory_outbound: boolean
  sync_orders_since: string | null
  outbound_pending: number
  outbound_failed: number
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
  const [url, setUrl] = useState("")
  const [siteId, setSiteId] = useState(sites[0]?.id ?? "")

  function add() {
    if (!url.trim()) {
      setError("Enter the store URL.")
      return
    }
    setError(null)
    startTransition(async () => {
      const res = await createConnection(url, siteId)
      if (!res.ok) setError(res.error)
      else {
        setUrl("")
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
            <Label className="text-xs">Store URL</Label>
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://my-store.com"
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
  const [key, setKey] = useState("")
  const [secret, setSecret] = useState("")
  const [webhook, setWebhook] = useState("")
  const savedSince = conn.sync_orders_since?.slice(0, 10) ?? ""
  const [since, setSince] = useState(savedSince)

  const hasApi = conn.has_consumer_key && conn.has_consumer_secret

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
    if (!key.trim() && !secret.trim() && !webhook.trim()) return
    setError(null)
    startTransition(async () => {
      const res = await setCredentials(conn.id, key, secret, webhook)
      if (!res.ok) setError(res.error)
      else {
        setKey("")
        setSecret("")
        setWebhook("")
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
          `Synced ${res.products} product${res.products === 1 ? "" : "s"}: ${res.created} new, ${res.updated} updated${res.skipped ? `, ${res.skipped} skipped` : ""}. Stock updated on ${res.stockSynced}, cost seeded on ${res.costSeeded}.` +
            (res.warning ? ` Note: ${res.warning}` : ""),
        )
        router.refresh()
      }
    })
  }

  function saveSince(value: string | null) {
    setError(null)
    setNote(null)
    startTransition(async () => {
      const res = await setSyncOrdersSince(conn.id, value)
      if (!res.ok) setError(res.error ?? "Something went wrong.")
      else {
        if (value === null) setSince("")
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
        // When some failed, show the first reason (e.g. a Read-only API key).
        if (res.failed && res.firstError) setError(res.firstError)
        router.refresh()
      }
    })
  }

  function syncInventory() {
    setError(null)
    setNote(null)
    startTransition(async () => {
      const res = await runOutboundDrainNow()
      if (!res.ok) setError(res.error)
      else {
        setNote(
          `Inventory pushed: ${res.pushed} sent` +
            (res.skipped ? `, ${res.skipped} skipped` : "") +
            (res.failed ? `, ${res.failed} failed` : "") +
            "." +
            (res.firstError ? ` First error: ${res.firstError}` : ""),
        )
        router.refresh()
      }
    })
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-medium">{conn.source}</span>
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
                  if (confirm(`Disconnect ${conn.source}?`))
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
          <Badge variant={hasApi ? "success" : "warning"}>
            <KeyRound /> {hasApi ? "API keys" : "No API keys"}
          </Badge>
          <Badge variant={conn.has_webhook_secret ? "success" : "warning"}>
            <KeyRound />{" "}
            {conn.has_webhook_secret ? "Webhook secret" : "No webhook secret"}
          </Badge>
          <Button
            size="sm"
            variant="outline"
            disabled={isPending}
            onClick={() => setCredOpen((v) => !v)}
          >
            {hasApi || conn.has_webhook_secret
              ? "Update credentials"
              : "Add credentials"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={isPending || !hasApi || !conn.has_webhook_secret}
            onClick={register}
          >
            <Webhook data-icon="inline-start" /> Register webhooks
          </Button>
          <Button size="sm" disabled={isPending || !hasApi} onClick={sync}>
            <RefreshCw data-icon="inline-start" /> Sync products
          </Button>
          <StoreImportRunner
            connectionId={conn.id}
            disabled={isPending || !hasApi}
            start={startOrderImport}
            step={stepOrderImport}
            cancel={cancelOrderImport}
          />
          <span className="text-xs text-muted-foreground">
            {conn.last_synced_at
              ? `Last synced ${formatDateTime(conn.last_synced_at)}`
              : "Never synced"}
          </span>
        </div>
      ) : null}

      {canManage ? (
        <div className="flex flex-wrap items-center gap-2 border-t pt-2">
          <span className="text-xs font-medium text-muted-foreground">
            Outbound stock
          </span>
          <Badge variant={conn.sync_inventory_outbound ? "success" : "muted"}>
            {conn.sync_inventory_outbound ? "On" : "Off"}
          </Badge>
          {conn.outbound_pending > 0 ? (
            <Badge variant="secondary">{conn.outbound_pending} queued</Badge>
          ) : null}
          {conn.outbound_failed > 0 ? (
            <Badge variant="destructive">{conn.outbound_failed} failed</Badge>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            disabled={isPending || !hasApi}
            onClick={() =>
              run(() =>
                setInventoryOutbound(conn.id, !conn.sync_inventory_outbound),
              )
            }
          >
            {conn.sync_inventory_outbound ? "Turn off" : "Turn on"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={isPending || !conn.sync_inventory_outbound}
            onClick={syncInventory}
          >
            <ArrowUpFromLine data-icon="inline-start" /> Sync inventory now
          </Button>
          <span className="text-xs text-muted-foreground">
            Pushes available (on-hand − reserved) to this store.
          </span>
        </div>
      ) : null}

      {canManage ? (
        <div className="flex flex-wrap items-center gap-2 border-t pt-2">
          <span className="text-xs font-medium text-muted-foreground">
            Order sync from
          </span>
          <Input
            type="date"
            value={since}
            onChange={(e) => setSince(e.target.value)}
            className="w-40"
            aria-label="Order sync from date"
          />
          <Button
            size="sm"
            variant="outline"
            disabled={isPending || since === savedSince}
            onClick={() => saveSince(since || null)}
          >
            Save
          </Button>
          {conn.sync_orders_since ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={isPending}
              onClick={() => saveSince(null)}
            >
              Clear
            </Button>
          ) : null}
          <span className="text-xs text-muted-foreground">
            {conn.sync_orders_since
              ? `Orders placed before ${savedSince} are skipped on import.`
              : "No floor — all history can import."}
          </span>
        </div>
      ) : null}

      {credOpen ? (
        <div className="flex flex-col gap-2 rounded-lg bg-muted/40 p-2.5">
          <div className="flex flex-col gap-1">
            <Label className="text-xs">Consumer key</Label>
            <Input
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={
                conn.has_consumer_key ? "•••• (leave blank to keep)" : "ck_…"
              }
              autoComplete="off"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs">Consumer secret</Label>
            <Input
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={
                conn.has_consumer_secret ? "•••• (leave blank to keep)" : "cs_…"
              }
              autoComplete="off"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs">Webhook secret</Label>
            <Input
              type="password"
              value={webhook}
              onChange={(e) => setWebhook(e.target.value)}
              placeholder={
                conn.has_webhook_secret
                  ? "•••• (leave blank to keep)"
                  : "a strong shared secret"
              }
              autoComplete="off"
            />
          </div>
          <div>
            <Button
              size="sm"
              onClick={saveCreds}
              disabled={
                isPending ||
                (!key.trim() && !secret.trim() && !webhook.trim())
              }
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
