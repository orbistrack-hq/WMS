# Store-sync webhooks (Shopify + WooCommerce)

How live order/product/inventory updates flow from the stores into the WMS, and
how to set them up. Phase B of the build plan.

## Architecture: receive → verify → dedupe → ack fast → process async

The webhook routes do almost nothing synchronously. They authenticate the
delivery, dedupe it, hand it to a queue, and return `200` in well under a
second. All the inventory/order work happens off the request, where it can be
retried safely. Doing the DB work inline is what makes a slow Supabase call look
like a failed delivery to the platform — which triggers a retry and risks
double-counting stock.

```
Shopify / Woo  ──POST──▶  /api/{channel}/webhooks         (receiver, this repo)
                              │  1. verify HMAC / signature  (per-store secret)
                              │  2. redisDedupe()            (fast-path, optional)
                              │  3. publishToQueue()  ──────▶ Upstash QStash
                              └─ 200 ack                        │ retries + dedupe
                                                                 ▼
                          /api/{channel}/webhooks/worker  ◀──POST── (worker, this repo)
                              │  verify worker secret
                              └─ processShopifyEvent / processWooEvent
                                     │
                                     ▼  guarded RPCs (create_order, fulfill_order, cancel_order)
                                  Supabase
```

**Graceful fallback.** When QStash is not configured (local dev, or Upstash not
yet provisioned), `queueEnabled()` is `false` and the receiver processes the
event **inline** instead — same `processXEvent()` code the worker runs. So
nothing is blocked on Upstash; the system is simply synchronous until you wire
it. Add the env vars and it flips to async with no code change.

**Where durable idempotency actually lives.** Not in Redis (it's volatile). The
money-critical guarantee is in the DB: `store_order_imports` has a unique
`(channel, source, external_order_id)` key, and `fulfill_order` / `cancel_order`
raise if the order is already in that state. Redis and QStash dedupe sit *in
front* of that as an optimization — they can never cause a double-apply, and if
they ever miss, the DB still catches it. This is why no new table/migration was
needed for the queue.

## What syncs

| Topic (Shopify / Woo)                          | Effect in WMS |
|------------------------------------------------|---------------|
| `orders/create` / `order.created`              | Import order, map variants → child SKUs, reserve stock via `create_order`. |
| `orders/updated`,`orders/fulfilled`,`orders/cancelled` / `order.updated`,`order.deleted` | Reconcile lifecycle of the existing WMS order: store-side **fulfilled** → `fulfill_order` (consume stock), **cancelled** → `cancel_order` (release stock). Self-healing: if we never imported the order, the update imports it. |
| `products/create`,`products/update` / `product.created`,`product.updated` | Upsert product → child SKU(s) at the connected site. |
| `products/delete` / `product.deleted`          | Deactivate the matching child SKU(s). |
| `inventory_levels/update`                       | **Subscribed but not yet applied** — see caveat below. |

**Conflict rule (per the build plan):** the store owns the *order's own
lifecycle*, so a store-side fulfilled/cancelled wins. WMS owns *available
stock* (it holds reservations). Lifecycle updates only ever move an order
forward (open → fulfilled/cancelled); a webhook never reopens a WMS order, since
WMS may have packed/shipped it locally.

### Caveat: `inventory_levels/update` is intentionally a no-op for now
Applying inbound stock safely needs **echo-loop protection**: when WMS pushes a
stock change to Shopify, Shopify fires `inventory_levels/update` right back, and
blindly applying it would fight our own write. The topic is subscribed so
deliveries arrive and are visible, but `processShopifyEvent` returns `ignored`
for it. Wiring the apply (tag outbound writes, skip the echo) is its own task.

## Environment variables

Add these in Vercel (Production + Preview) and `.env.local` for local work.
None are required to run — without them the receiver just processes inline.

```bash
# --- Queue (Upstash QStash). Omit all three to run inline (no async queue). ---
QSTASH_TOKEN=                     # from the Upstash QStash console
STORE_SYNC_PUBLIC_URL=https://your-app.vercel.app   # public origin QStash POSTs back to (never localhost)
STORE_SYNC_WORKER_SECRET=         # long random string; the worker checks it. e.g. `openssl rand -hex 32`
# QSTASH_URL=                     # optional; defaults to https://qstash.upstash.io

# --- Redis fast-path dedupe (Upstash Redis). Optional; durable dedupe is in the DB. ---
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=

# --- Per-store HMAC secrets are stored in store_secrets (entered in the UI).
#     These env fallbacks are only used if a store has no secret row. ---
# SHOPIFY_WEBHOOK_SECRET=
# WOOCOMMERCE_WEBHOOK_SECRET=
```

Cost: QStash and Upstash Redis both have free tiers that comfortably cover this
workload, so this stays within the project's infra budget.

## Registering the webhooks on a store

Both are one click from the WMS Integrations UI — the server action posts the
subscriptions to the store's API, signed with that store's stored secret, and
re-running is idempotent (existing subscriptions are skipped, not duplicated).

**Shopify** (`registerWebhooks` in `app/(app)/integrations/shopify/actions.ts`):
1. In the store's connection, save its Admin API **access token** and **API
   secret** (the secret is what signs webhook HMACs).
2. Click **Register webhooks**. It subscribes `orders/create`,
   `orders/updated`, `orders/fulfilled`, `orders/cancelled`,
   `products/create|update|delete`, and `inventory_levels/update`, all pointed
   at `https://<host>/api/shopify/webhooks`.
3. Pin the API version: `SHOPIFY_API_VERSION` in that file (currently
   `2024-10`). Bump it deliberately, not automatically.

**WooCommerce** (`registerWebhooks` in
`app/(app)/integrations/woocommerce/actions.ts`):
1. Save the store's REST **consumer key/secret** and a **webhook secret**.
2. Click **Register webhooks**. It subscribes `order.created`, `order.updated`,
   `order.deleted`, and `product.created|updated|deleted`, pointed at
   `https://<host>/api/woocommerce/webhooks`.

To register by hand instead: Shopify Admin API `POST /admin/api/<ver>/webhooks.json`
per topic; Woo → Settings → Advanced → Webhooks (set the **Secret** to match the
store's `webhook_secret`).

## Verifying it works
- Create a test order in the store → it appears in WMS within a few seconds with
  stock reserved. Mark it fulfilled/cancelled in the store → WMS reflects it.
- Re-send the same delivery from the platform's webhook log → WMS returns
  `duplicate` and does **not** double-apply.
- With QStash configured, the receiver response shows `{ queued: true }`; the
  actual work shows up in the QStash message log + the worker route logs.

## Outbound inventory sync (WMS → store)

The reverse direction: when WMS stock changes, push the new **available**
(`on_hand − reserved`) to the connected storefront so it can't oversell stock
already committed to WMS orders. Added in migration `0026`. **Shopify and
WooCommerce adapters are both wired**; any future channel parks visibly as
`skipped` rather than silently dropping stock.

**Capture point — one trigger, every path.** A trigger on `inventory_ledger`
enqueues a coalesced job into `store_outbound_inventory_jobs` for *every* stock
movement (manual adjust, order reserve/release/consume, layaway, receipt),
regardless of which code path caused it. One pending job per child SKU (a burst
collapses to the latest target).

**Loop suppression.** Movements with reason `shopify_sync` came *from* a store
sync (`set_on_hand_to`), so they are **not** re-enqueued — that's what stops the
inbound↔outbound echo. The inbound `inventory_levels/update` apply is still
deliberately unwired (see `process-event.ts`); outbound is safe to run without it.

**Drain.** `lib/store-sync/outbound.ts#drainOutboundInventory` claims due jobs
(`claim_outbound_inventory_jobs`, `FOR UPDATE SKIP LOCKED`), pushes the **live**
available (recomputed at claim time, never a stale snapshot) via Shopify REST
`inventory_levels/set.json` (absolute set → converges, idempotent), then records
the outcome (`complete_outbound_inventory_job`): done / permanent skip (bad
mapping) / retry with exponential backoff, failing after 8 attempts. claim +
complete are SECURITY DEFINER, service-role only.

**What it pushes to / needs.**
- *Shopify* needs `child_skus.store_inventory_item_id` (captured during **Sync
  products**) and `store_connections.inventory_location_id` (auto-captured on
  Sync products from `locations.json`). Sets via `inventory_levels/set.json`.
- *WooCommerce* sets `stock_quantity` (with `manage_stock: true`) via
  `PUT /products/{id}` for simple products and
  `PUT /products/{parent}/variations/{id}` for variations — so a variation needs
  `child_skus.store_parent_id`, captured during **Sync products**. Auth is the
  consumer key/secret already stored for the connection.

Missing any required id → the job is `skipped` with a clear reason; re-run
**Sync products** on that store to backfill the ids.

**Triggering the drain (two layers).**
1. *Immediate kick* — inventory/order server actions and the Shopify webhook
   worker call `kickOutboundDrain()` (bounded, fully error-swallowing) so pushes
   go out near-instantly.
2. *Schedule (safety net)* — `GET/POST /api/store-sync/outbound`, authed by the
   forwarded worker secret (`x-wms-worker-key`, for a QStash schedule) **or**
   Vercel Cron (`Authorization: Bearer $CRON_SECRET`). `vercel.json` registers a
   1-minute cron (needs a plan that allows per-minute crons; otherwise point a
   QStash schedule at the same route).

**Rollout.** `store_connections.sync_inventory_outbound` defaults **off**. Enable
one store at a time from the Shopify integrations page; the page shows queued /
failed counts and a **Sync inventory now** button (manual drain).

**Tests.** `supabase/tests/18_outbound_inventory_sync.sql` covers enqueue, loop
suppression, coalescing, live-available claim, backoff, the failure cap, and
supersede. (The HTTP push itself isn't covered by pgTAP.)

## Operational note: webhooks go stale
Both platforms disable webhooks after repeated delivery failures (Woo flips them
to *disabled*; Shopify drops a subscription after ~19 failures over 48h). A
Vercel outage can therefore leave you quietly desynced. Mitigation: the existing
**backfill** actions (`syncPastOrders`) re-pull recent orders via REST and are
idempotent — run them on a schedule, and re-click **Register webhooks** to
re-create any dropped subscriptions. A periodic reconciliation job is the
durable fix (not yet built).

## Testing
The risky logic to cover (per the build plan): dedupe idempotency, the
lifecycle-update decision (forward-only, no reopen), and variant→SKU mapping.
There is no JS test runner wired in `package.json` yet — `supabase/tests` holds
pgTAP DB tests only. Adding Vitest is a small, separate task; until then,
`pnpm exec tsc --noEmit` is the compile gate and the pgTAP suite covers the
guarded RPCs the processors call.
```bash
pnpm exec tsc --noEmit     # typecheck the refactor
```
