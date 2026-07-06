# OrbisTrack — Go-Live Checklist

Target: Milestone 3 launch. Work top-to-bottom; **§0–§4 are hard gates** (don't
enable a real store until they're green). §5–§9 harden and roll out.

Legend: `[ ]` todo · `[~]` in progress / partial · `[x]` done. (S)/(M)/(L) = effort.
_Last updated from status review — J._

---

## 0. Clean, green baseline (do first)

- [x] Commit the outstanding working-tree changes.
- [x] `pnpm build` clean · `pnpm lint` clean · `pnpm typecheck` clean · `pnpm test` green.
- [x] CI passes on `main` (db-tests + unit-tests) and deploys.
- [x] `README.md` refreshed (Woo, outbound sync, intake, Sentry, Vitest/Playwright, site-scoped RLS).
- [ ] Tag a release (e.g. `v0.1.0-rc1`) so there's a rollback point. (S)

## 1. Production environment & infra

- [~] Prod env vars set in Vercel — **all set except `QSTASH_TOKEN` / `QSTASH_URL`
      / `UPSTASH_REDIS_REST_TOKEN` / `UPSTASH_REDIS_REST_URL`.** Needed for the
      outbound job queue + schedule; set before enabling outbound sync on any live store.
- [ ] Verify the service-role key is server-only (never in the client bundle).
      ▸ **How:** it must never be `NEXT_PUBLIC_*`. Confirm it's only read in server
      code — `grep -rn "SUPABASE_SERVICE_ROLE_KEY" app lib` should return only
      server files (route handlers, `lib/supabase/admin`, drain), never a
      `"use client"` component. Then build and scan the client output:
      `grep -r "service_role" .next/static` must return nothing.
- [x] Supabase on **Pro** plan — confirm PITR / automated backups are enabled in the dashboard.
- [x] All migrations (through `0033`) pushed to prod.
- [~] **Outbound drain cadence.** Vercel rejects per-minute (`* * * * *`) on the
      plan, so `0 0 * * *` (daily) is the current backstop — fine as a fallback,
      but coarse. Once QStash/Upstash is configured, point a **QStash schedule**
      at `/api/store-sync/outbound` (authed by `STORE_SYNC_WORKER_SECRET`) for a
      1-min cadence; the inline `kickOutboundDrain()` still handles most pushes
      instantly. (S)
- [x] Sentry receiving events from the prod deploy.
- [ ] Promote first admin user (`profiles.role = 'admin'`); create staff/operator accounts. (S)
      ▸ Use `scripts/provision-user.sql` (or Studio → Authentication → Add user, then
      set the role). Roles: `admin` (full), `operator` (internal, all sites — the
      default for new signups), `client` (external, per-site via `user_site_access`).
- [ ] **Disable public signup in prod, or gate it.** `enable_signup = true` +
      the `handle_new_user` trigger default of `operator` means anyone who reaches
      `/auth/sign-up` gets an all-sites internal account. Before go-live, turn off
      public signup in the prod Supabase Auth settings and provision users from
      Studio (or restrict signup), then confirm no unexpected `operator` profiles
      exist. (S)

## 2. Data migration (Phase C)

- [x] Exported catalog/inventory/orders from Shopify **and** WooCommerce on the deployment.
- [~] Map to parent → child-SKU-per-site. **Duplicate resolution delegated to
      managers** (via the duplicate-review screen) — not a solo task.
- [x] Load via intake/allocation flow — followed the UAT, working flawlessly.
- [ ] Reconcile migrated on-hand/reserved vs. source of truth per site (ties to §3 invariant).
- [ ] Dry-run the full migration once end-to-end, time it, write the runbook.

## 3. UAT sign-off (lightweight)

- [~] `INTAKE-ALLOCATION-UAT.md` — intake/allocation steps followed and passing;
      record results for the remaining steps.
- [~] **Prove the core invariant:** parent bulk is never synced; each child pushes
      its exact unit count. _CI now proves the key pieces: outbound enqueues one
      job per child SKU carrying its live unit count (`tests/18` line 37), unmapped
      SKUs never enqueue (line 65), and parent grams live in a separate ledger
      (`tests/19`). Remaining: one explicit "a parent-grams movement enqueues
      nothing" assertion, plus a live dev-store confirmation before enabling._
- [x] Manual order → pick → pack → ship → fulfill on one site — working well.
- [x] Combined-order case: box/label counted once per group, consumables summed — working well.
- [~] Layaway + post-dated + hold — layaway **payments/installments** now covered
      in pgTAP (`tests/03_payments.sql`, layaway order); post-dated / hold covered.
      Remaining: manual end-to-end layaway run (stock removed now, paid later).
- [~] Short shadow run: one location, one day, alongside the current process.
      ▸ Sign-off sheet ready: `CORE-WORKFLOWS-UAT.md` — 12 scenarios (reserve/release/
      consume, combine, hold, layaway, post-date, adjust, import, push, reports, RLS)
      each with expected before/after numbers, a pass column, and DB assertion queries
      (all verified to run against the seeded schema). Run it on one location to sign off.

## 4. Store sync rollout (one store at a time)

- [x] Webhooks registered and stores synced; mapping ids backfilled (Sync products).
- [x] Inbound order import confirmed idempotent (replayed webhook, no double count).
- [~] Enable `sync_inventory_outbound` — **testing on the dev store first.** Prove
      the §3 invariant here, then enable one live store.
- [ ] Watch queued/failed counts on the integrations page; drive failures to zero.
- [ ] Only after that store is stable, enable the next.

## 5. Monitoring, recovery & known gaps

- [~] **Reconciliation job** — DRAFTED in `supabase/snippets/inventory_reconciliation.sql`:
      two views (`inventory_level_reconciliation` = levels vs ledger sum per SKU;
      `parent_child_reconciliation` = parent grams vs committed child grams) plus a
      service-role `reconcile_inventory()` that returns only drifting rows for
      alerting. Remaining: review, confirm the parent/child identity, run on a
      branch, promote to a migration, wire a route + schedule. (M)
- [ ] **Webhook staleness recovery:** schedule the idempotent `syncPastOrders`
      backfill + periodic webhook re-registration (platforms auto-disable
      webhooks after repeated failures). (M)
- [ ] Confirm the by-design gap with the team: inbound store→WMS inventory updates
      are deliberately **not** wired (`lib/shopify/process-event.ts:64`).
- [ ] Sentry alert rules on failed inventory transitions and webhook worker errors.
- [ ] Documented rollback trigger + steps (disable outbound sync, restore backup).

## 6. Security review

- [~] **Site-scoped RLS active in prod** (`can_access_site`) — proven in CI by
      `tests/05_rls.sql` (runs as the real `authenticated` role with simulated JWT
      claims: a client sees only its assigned site's SKUs, an operator sees all).
      Remaining: confirm the same holds in **prod** via the manual check below.
      ▸ **How:** in the SQL editor, `set role authenticated;` then
      `set request.jwt.claims` to a staff user of site A and
      `select * from inventory_levels where site_id = '<site B>';` → must return
      zero rows. Repeat for a delete on another site's row → must be denied.
- [~] **Store-secret lockdown** — proven in CI by `tests/10_shopify_secrets_lockdown.sql`
      (authenticated role gets `42501` reading `store_secrets`; the status view
      exposes only `has_token`/`has_secret` booleans, never raw values).
      Remaining: confirm in **prod** via the manual check below.
      ▸ **How:** as a non-service role, `set role authenticated; select * from
      store_secrets;` should error or return nothing. Also confirm the grants:
      `\dp store_secrets` (or query `information_schema.role_table_grants`) shows
      no SELECT for `anon`/`authenticated`; only `service_role`. The lockdown
      migration is `…_lock_shopify_secrets`.
- [~] **Webhook signature verification enforced** — enforced in code and now
      unit-tested. Both receiver routes read the **raw** body, HMAC-SHA256 it
      against the per-store secret, and return **401 before any enqueue** on
      mismatch (`app/api/shopify/webhooks/route.ts`, `.../woocommerce/...`). The
      new `lib/store-sync/webhook-contract.test.ts` asserts accept-good /
      reject-tamper / reject-wrong-secret / reject-missing-header for both
      channels. Remaining: confirm `SHOPIFY_WEBHOOK_SECRET` /
      `WOOCOMMERCE_WEBHOOK_SECRET` (or per-store secrets) are set in prod and do a
      live bad-signature → 401 spot check.
      ▸ Read the **raw** request body (not the parsed JSON) and HMAC-SHA256 it with
      the store secret, comparing timing-safe against the header —
      `X-Shopify-Hmac-Sha256` (base64) for Shopify, `X-WC-Webhook-Signature`
      (base64) for Woo — returning **401** on mismatch before any processing.
      Confirm `SHOPIFY_WEBHOOK_SECRET` / `WOOCOMMERCE_WEBHOOK_SECRET` are set in
      prod, then test: POST a payload with a bad signature → must 401; with a good
      one → 200. Grep the routes to confirm the check runs before enqueue.
- [ ] **Public signup lockdown** — `enable_signup = true` + the `handle_new_user`
      trigger default of `operator` grants all-sites internal access to anyone who
      signs up. Disable/gate public signup in prod and provision users deliberately
      (see §1). Then verify: `select email, role from profiles p join auth.users u
      on u.id = p.id where role = 'operator';` should list only your team.
- [ ] `/security-review` pass on the pending diff before the final merge.

## 7. Test coverage to add before launch

- [x] Webhook contract tests: `lib/store-sync/webhook-contract.test.ts` replays
      recorded Shopify/Woo payloads and asserts authentication (accept/reject) plus
      idempotency (stable dedupe key on re-delivery; distinct events distinct keys;
      Woo retries collapse on body hash). 7 tests, green in the 81-test suite.
- [x] Playwright `pack-ship` spec proven.
- [x] Migration round-trip test: `supabase/tests/roundtrip/roundtrip.py` applies all
      41 migrations forward, reverse-applies every `rollback/*.down.sql`, and asserts
      the `public` schema is empty again. The 6 missing `down` files (0017, 0018,
      0019, 0020, 0021, 0027) were authored and verified. Passes locally against a
      real Postgres 16 and is wired into CI as the `migration-roundtrip` job (a
      `postgres:16` service container); `deploy-migrations` now depends on it, so a
      non-reversible migration blocks the prod deploy.

## 8–10. Team readiness, go-live day, post-launch — **owned by managers/ops**

Delegated (not J). Summary of what that covers, for handoff:

- **Team readiness:** mobile picking view checked on floor devices; staff
  cheat-sheet (create order, pick, pack, ship, combine, hold); support path for
  sync failures / wrong numbers.
- **Go-live day:** freeze current tool (read-only) at cutover; migrate the pilot
  site and reconcile counts before opening the app; enable that site's store and
  watch queues for the first hour; process the first orders with someone watching;
  sanity-check all reports.
- **Post-launch (week 1):** daily reconciliation review until drift is zero; daily
  Sentry triage; roll out to the next location once the pilot is stable.
