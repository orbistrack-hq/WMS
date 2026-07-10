# QStash setup — stop the self-disabling webhook

## Why this fixes it

`app/api/{shopify,woocommerce}/webhooks/route.ts` only hands work off asynchronously
when **QStash is configured**. When it isn't, `queueEnabled()` is `false` and the route
processes the whole event **inline, on the ack path** — so a burst of syncs (like the
overnight bulk load) makes each webhook slow to return `200`. WooCommerce marks slow
deliveries as failed and, after a few, **disables the webhook**; Shopify just keeps
retrying, which piles up.

With QStash on, the route verifies the signature, enqueues, and returns `200` in
milliseconds. The heavy DB work runs in the worker route (`.../webhooks/worker`) with
QStash's automatic retries, and the durable idempotency in `store_order_imports`
guarantees no double-counting. The store stops seeing failures, so Woo stops disabling
the webhook and Shopify's retry pile clears itself.

`queueEnabled()` needs **all three** of these set (see `lib/store-sync/queue.ts`):

| Env var | What it is |
| --- | --- |
| `QSTASH_TOKEN` | Your QStash API token |
| `STORE_SYNC_PUBLIC_URL` | The public origin QStash POSTs back to (your prod URL) |
| `STORE_SYNC_WORKER_SECRET` | A long random string the worker route checks |

Two optional vars enable the fast pre-worker dedupe (`redisEnabled()`):
`UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`. Recommended but not required.

---

## Step 1 — Get `QSTASH_TOKEN`

1. Go to the [Upstash Console](https://console.upstash.com/) and open **QStash** in the
   left sidebar.
2. On the QStash page, find the **Request Builder / API Keys** area. The value labelled
   **`QSTASH_TOKEN`** is what you want — copy it.
   - ⚠️ Do **not** use the `QSTASH_CURRENT_SIGNING_KEY` / `QSTASH_NEXT_SIGNING_KEY`
     values. This project authenticates the worker with its own forwarded secret
     (`x-wms-worker-key`), not QStash signature verification, so those signing keys
     aren't used.

## Step 2 — Generate `STORE_SYNC_WORKER_SECRET`

Any long random string. From a terminal:

```bash
openssl rand -hex 32
```

Copy the output. This is a value **you invent** — it isn't from Upstash. The webhook
route forwards it to the worker and the worker checks it, so publishing and the worker
just have to agree (they will, because both read the same env var).

## Step 3 — Set `STORE_SYNC_PUBLIC_URL`

This is the **public production URL of the app** — the origin QStash will POST the job
back to. Use your real prod domain, e.g. `https://wms.yourdomain.com` or the Vercel prod
URL `https://<project>.vercel.app`. **No trailing slash, never `localhost`, never a
preview URL.**

QStash will call `https://<STORE_SYNC_PUBLIC_URL>/api/woocommerce/webhooks/worker` (and
the shopify equivalent), so that origin must be publicly reachable — see the gotcha
below about Vercel Deployment Protection.

## Step 4 — (Optional but recommended) Upstash Redis for dedupe

1. In the Upstash Console, create a **Redis** database (any region close to your Vercel
   region).
2. Open it and scroll to the **REST API** section. Copy:
   - **`UPSTASH_REDIS_REST_URL`** → `UPSTASH_REDIS_REST_URL`
   - **`UPSTASH_REDIS_REST_TOKEN`** → `UPSTASH_REDIS_REST_TOKEN`

## Step 5 — Put them in Vercel

Vercel → your project → **Settings → Environment Variables**. Add each var for the
**Production** environment (add to **Preview** too if you test syncs there):

```
QSTASH_TOKEN=<from step 1>
STORE_SYNC_PUBLIC_URL=https://<your prod url>
STORE_SYNC_WORKER_SECRET=<from step 2>
# optional dedupe
UPSTASH_REDIS_REST_URL=<from step 4>
UPSTASH_REDIS_REST_TOKEN=<from step 4>
```

Then **redeploy** — Vercel only picks up new env vars on a fresh deployment. Trigger a
redeploy of the current production commit (Deployments → ⋯ → Redeploy).

## Step 6 — Verify the queue is actually on

After the redeploy, a live webhook (or a manual test event) should return
`{"ok":true,"queued":true}` instead of doing inline work. Quick checks:

- **Upstash → QStash → Logs / Messages**: you should see messages being published and
  delivered to `.../webhooks/worker` with `200` responses.
- **Vercel logs** for the worker route (`/api/woocommerce/webhooks/worker`) should show
  it running and returning `200`.
- Any permanently-bad event lands in the **QStash DLQ** after 5 attempts — check the DLQ
  is empty (or inspect anything sitting there).

## Step 7 — Re-enable the Woo webhook and clear the backlog

1. **WooCommerce** → **Settings → Advanced → Webhooks** → open the disabled webhook →
   set **Status = Active** → Save. (Woo disabled it after the failures; it won't
   re-enable itself.)
2. **Shopify**: its webhooks are still registered and retrying, so they'll simply start
   getting fast `200`s and drain on their own. Nothing to re-enable.
3. The overnight backlog resolves itself: the stores replay their pending retries, each
   now acked in milliseconds and processed by the worker. Redis dedupe + the
   `store_order_imports` unique key ensure the replays don't double-count stock.

---

## Gotcha to check first — Vercel Deployment Protection

If **Deployment Protection** (Vercel Authentication / password) is enabled on the
Production deployment, QStash's POST to `.../webhooks/worker` gets intercepted by
Vercel's auth wall and the worker **never runs** — so the queue would silently do
nothing. Make sure the worker routes are publicly reachable. Options: disable protection
for production, or add a bypass. The worker is still protected by
`STORE_SYNC_WORKER_SECRET`, so it isn't open — it's authenticated by the forwarded
secret, not by Vercel's wall.

## Note on the outbound cron

`vercel.json` currently runs the outbound drain (`/api/store-sync/outbound`) once daily
(`0 0 * * *`). That's the WMS→store push path and is separate from the inbound
self-disable issue above. If outbound updates feel laggy, that cron cadence — not
QStash — is the thing to revisit (`STORE-SYNC-WEBHOOKS.md` covers it).
