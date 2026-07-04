# OrbisTrack — Warehouse Management System

OrbisTrack is a multi-site warehouse management system (WMS) for running catalog,
inventory, order, picking/packing, shipping, billing, and reporting workflows out
of one application. It is built for 3PL-style operations where stock, fees, and
fulfillment must be tracked per physical site and where orders can arrive both
manually and from connected e-commerce stores (Shopify and WooCommerce).

The core design goal is **auditable correctness**: inventory never drifts,
financial figures are snapshotted so history never rewrites itself, and every
state change is either guarded by a database function or recorded in an
append-only ledger.

---

## Table of contents

- [Status & milestones](#status--milestones)
- [Tech stack](#tech-stack)
- [Architecture overview](#architecture-overview)
- [Data model](#data-model)
- [Current features](#current-features)
- [Key design decisions](#key-design-decisions)
- [Project structure](#project-structure)
- [Local development](#local-development)
- [Testing](#testing)
- [Roadmap — planned features](#roadmap--planned-features)
- [Future optimizations](#future-optimizations)
- [Security model](#security-model)

---

## Status & milestones

OrbisTrack is at version `0.1.0` and in **go-live hardening**. Work was organized
into three milestones, all now substantially built:

| Milestone | Scope | Hours | Window | Status |
|-----------|-------|-------|--------|--------|
| 1 — Foundation, Catalog & Inventory | Schema, RLS, inventory state machine, catalog, inventory UI | 20 | Jun 22 – Jun 25 | ✅ Built |
| 2 — Orders, Packing & Shipping | Order lifecycle, packing, packaging costs, shipping, pick lists | 25 | Jun 26 – Jun 30 | ✅ Built |
| 3 — Integrations, Reporting, Testing & Go-Live | Shopify + WooCommerce sync, reporting, hardening, launch | 25 | Jul 1 – Jul 6 | 🔶 Hardening |

The catalog, inventory, orders, packing, shipping, both store integrations
(Shopify **and** WooCommerce), outbound inventory sync, the grams-based
intake/allocation flow, and the reporting views all exist in the codebase. CI
(pgTAP + lint + typecheck + Vitest) passes on `main` and deploys. Remaining
Milestone-3 work is launch hardening — the go-live checklist
([`GO-LIVE-CHECKLIST.md`](./GO-LIVE-CHECKLIST.md)) tracks it: UAT sign-off, a
level↔ledger reconciliation job, security verification, and per-store rollout.

---

## Tech stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 16 (App Router, React Server Components) |
| UI | React 19, Tailwind CSS v4, shadcn/ui, Radix/Base UI primitives, lucide-react icons |
| Backend / DB | Supabase (PostgreSQL 15+) with Row Level Security |
| Auth | Supabase Auth (email/password) via `@supabase/ssr` |
| Business logic | PostgreSQL functions (PL/pgSQL) called as RPCs from Next.js server actions |
| Store-sync queue | Upstash Redis + QStash (outbound inventory job drain) |
| Migrations / local stack | Supabase CLI (`supabase db`, `supabase test db`) |
| Testing | pgTAP (database), Vitest (unit), Playwright (E2E) |
| Monitoring | Sentry (client + server + edge) |
| CI | GitHub Actions — pgTAP + lint + typecheck + Vitest on every push / PR; migrations auto-deploy on merge to `main` |
| Hosting | Vercel (app) + Supabase (database) |
| Package manager | pnpm 10 |

---

## Architecture overview

OrbisTrack pushes the hard correctness guarantees down into the database and
keeps the Next.js layer thin.

```
┌──────────────────────────────────────────────────────────┐
│  Next.js App Router (RSC + Server Actions)                 │
│  app/(app)/* pages → actions.ts → Supabase RPC calls       │
└───────────────────────────┬──────────────────────────────┘
                            │  authenticated Supabase client
                            ▼
┌──────────────────────────────────────────────────────────┐
│  PostgreSQL (Supabase)                                      │
│  • Tables + generated columns + CHECK constraints          │
│  • Guarded RPC functions (state machine, order lifecycle)  │
│  • Append-only inventory_ledger + generic audit_log        │
│  • Row Level Security on every table                       │
│  • Reporting views (security_invoker)                      │
└───────────────────────────┬──────────────────────────────┘
                            │  webhooks + outbound job drain
                            ▼
┌──────────────────────────────────────────────────────────┐
│  Store channels (Shopify, WooCommerce)                     │
│  • Inbound: signed webhooks → fast-ack → queue → import    │
│  • Outbound: coalesced per-SKU jobs → absolute-set push    │
└──────────────────────────────────────────────────────────┘
```

Three rules hold the system together:

1. **Inventory only moves through guarded functions.** Reserving, releasing,
   consuming, laying away, receiving, and adjusting stock all go through
   PL/pgSQL functions that lock the level row (`SELECT … FOR UPDATE`), validate
   the transition, and write the level change and a matching ledger row in the
   same transaction. Bare `UPDATE`s to inventory are never issued from the app.
2. **Status transitions are guarded RPCs.** Orders move through their lifecycle
   via `set_order_status`, `fulfill_order`, and `cancel_order` — never raw client
   updates — so inventory side-effects fire exactly once per transition.
3. **Financials are snapshotted.** Pick-fee rates, packaging unit costs, and COGS
   are frozen onto the record at the moment they are charged, so later price
   changes can never rewrite already-billed history.

Store sync is idempotent in both directions: inbound webhooks dedupe on the
external id so a replay never double-counts, and outbound jobs push the **live**
available as an absolute set (`inventory_levels/set.json` on Shopify,
`stock_quantity` on Woo) so retries converge rather than drift.

Authentication is enforced in `middleware.ts` (session refresh) and in the
`app/(app)/layout.tsx` server layout, which redirects unauthenticated users to
`/auth/login`.

---

## Data model

The schema is defined across numbered Supabase migrations under
`supabase/migrations/`. The core entities:

**Identity & access**
- `profiles` — one per auth user, with a `role` enum (`admin` | `staff`). A
  trigger auto-creates a profile on signup; the first user is promoted to admin
  manually.
- `sites` — physical warehouse locations. Inventory and child SKUs are per-site;
  `can_access_site` scopes staff to their assigned site(s).

**Catalog**
- `categories` — multi-level via adjacency list (`parent_id`); cycle prevention
  in the app layer.
- `products` — the master/parent product. Names are intentionally not unique.
- `child_skus` — the atomic sellable unit: one product at one site, with its own
  `sku`, `price`, `cost`, `bin_location`, `barcode`, `grams_per_unit`, and store
  mapping ids (`store_variant_id` / `store_inventory_item_id` / `store_parent_id`)
  for external sync. Unique per `(product_id, site_id)`; SKU codes unique per site.

**Inventory**
- `inventory_levels` — materialized per-SKU counters: `on_hand`, `reserved`,
  `layby`, and a generated `available = on_hand − reserved`. CHECK constraints
  prevent negative stock and overselling (`on_hand >= reserved`). Created
  automatically per child SKU via trigger.
- `inventory_ledger` — append-only movement log. Every level change writes a
  paired ledger row recording the delta, reason (`order_reserve`,
  `order_consume`, `layaway_remove`, `receipt`, `manual_adjustment`, …),
  reference, note, and actor.
- `parent_inventory` — grams-level bulk held at the parent × site, consumed by
  the intake/allocation flow when splitting bulk into weight-variant child SKUs.
  The parent bulk itself is never store-mapped and never pushed to a channel.

**Customers & fulfillment**
- `customers` — lightweight, first-class, with `external_ref` JSON for platform IDs.
- `fulfillment_groups` — every order belongs to one. Box/label, shipping, and
  packaging consumption attach to the group so combined orders are never
  double-counted; a solo order is a group of one.

**Orders**
- `orders` — auto-numbered (`ORD-000001`), per site, with `channel`
  (`manual` | `shopify` | `woocommerce`), `status`
  (`created → picking → packed → fulfilled` / `cancelled`), an orthogonal
  `on_hold` flag, `order_type` (`standard` | `layaway`), a generated `ship_to_key`
  for combine-matching, and post-dated sale support (`sale_date` distinct from
  `entered_at`). Backorder state is tracked when stock is short.
- `order_line_items` — per child SKU, with quantity, unit price, discount, tax.

**Packaging & shipping**
- `packaging_types` — boxes, labels, jars, vacuum bags, etc., each with a unit cost.
- `packaging_stock` — per-site on-hand of each packaging type, decremented at pack.
- `packaging_usage` — recorded against the group, with `unit_cost_snapshot`
  frozen at pack time.
- `shipments` → `packages` — a group can have multiple shipments and multiple
  packages, with carrier, service level, estimated/actual cost, tracking, weight.

**Billing**
- `fee_schedules` — effective-dated pick-fee rates (first-unit + additional-unit;
  seeded at $1.25 / $0.25). Designed for future per-client rates.
- `billing_charges` — per-order charges (`pick_fee`, `packaging_charge`, `insert`,
  `kitting`, `labor`, `other`) with the resolved rate snapshotted so re-pricing
  never alters billed orders.
- Storefront cost-reporting views roll up postage + all packaging per brand/site
  for monthly reimbursement billing.

**Store sync**
- `store_connections` / `store_secrets` — per-store config and locked-down
  credentials, with an `sync_inventory_outbound` toggle (default off).
- `store_order_imports` — inbound idempotency ledger keyed by external order id.
- `store_outbound_inventory_jobs` — coalesced per-SKU push queue with backoff.

**Audit**
- `audit_log` — generic before/after JSON snapshots written by an `audit_row`
  trigger attached to the operational tables.

---

## Current features

### Catalog management
Full product catalog with multi-level categories, parent products, and per-site
child SKUs. Includes a category manager, product create/edit forms, child-SKU
management per product, **duplicate detection and merge** (both automatic and
manual, weight-aware), SKU **reparenting** between products, and a duplicate-review
screen for managers.

### Inventory
Per-SKU on-hand / reserved / available / layby visibility with site-scoped
filtering and a zero-stock toggle. Manual stock adjustments and receipts flow
through guarded functions and are fully recorded in the append-only ledger. A
per-SKU detail view exposes an adjustment panel; a by-parent view rolls up across
child SKUs.

### Inventory state machine
Atomic, concurrency-safe stock primitives:
- **Standard:** `reserve → release` (on cancel) / `consume` (on fulfill).
- **Layaway:** `book` (removes from on-hand now) → `cancel` / `consume`.
- **Stock-in / correction:** `receive`, `adjust` (signed, note-required).

Each locks the level row, validates with clear error messages, and writes level +
ledger together. Order-level orchestrators (`apply_order_creation`,
`apply_order_cancellation`, `apply_order_fulfillment`) branch on order type and
apply the right primitive to every line.

### Intake & allocation
Bulk grams are received at the parent × site (`parent_inventory`), then allocated
out to weight-variant child SKUs (e.g. 3.5/7/14/28g), converting grams to units
via `grams_per_unit`. Saving an allocation enqueues the affected child SKUs for
outbound push. The parent bulk is never store-mapped, so it can never be synced.

### Orders
Create orders (via the `create_order` RPC), edit, hold/un-hold, and move through
the lifecycle. Standard orders reserve stock at creation; layaway orders remove
it from on-hand immediately. Supports post-dated sales, per-order ship-to
addresses, discounts, tax, customer attachment, order payments, and backorders.
Cancellation and fulfillment release or consume stock through the guarded
transitions.

### Fulfillment groups & order combining
Orders sharing a customer/ship-to are grouped so packaging, box/label, and
shipping costs are counted **once** across combined orders.

### Picking & packing
A per-group pick list (`packing/[id]/pick-list`) aggregates line items by child
SKU across the group's active orders. An interactive, mobile pick runner
(`pick_progress`) drives the `created → picking → packed` transitions with
tap-to-check-off and optional barcode scan-to-pick (feature-flagged via
`NEXT_PUBLIC_SCANNING_ENABLED`); bin locations sort the list by physical position.
A wave view aggregates picks across groups. Packing records packaging usage
against the group (`record_packaging_usage`), decrements per-site packaging stock,
and snapshots packaging costs, with a packaging editor and pack-confirm step.

### Billing & pick fees
Effective-dated fee schedules resolve the correct rate as of the order's
fulfillment date. `calc_order_pick_fee` / `charge_order_pick_fee` /
`charge_group_pick_fees` compute and record the first-unit-premium-once-per-order
pricing, snapshotting the rate onto each charge.

### Shipping
Per-group shipments and packages, managed from a shipping panel on the packing
detail screen (`packing/[id]`). A group can carry multiple shipments, each with
multiple packages, recording carrier, service level, estimated/actual cost,
tracking number, and weight. Guarded RPCs (`create_shipment`, `update_shipment`,
`set_shipment_status`, `add_package`, `update_package`) mirror the packing layer.
Shipping is **operational only** — moving a shipment through `pending → shipped →
delivered` (or `cancelled`) never consumes inventory or closes an order;
fulfillment stays a separate, explicit step (`fulfill_order`).

### Store integrations (Shopify & WooCommerce)
Self-serve store connection, product/variant import, and order import via signed
webhooks (`app/api/shopify/*`, `app/api/woocommerce/*`). Webhooks fast-ack and
enqueue to a worker; each external **variant** maps idempotently to a WMS product
+ child SKU at the connected store's site — the store owns name/price/SKU, WMS
owns cost — with cost/inventory sync, COGS snapshotting, secret lockdown, and
SKU-level unflattening. Forward sync sets `grams_per_unit` and groups
weight-variant products under one parent. **Outbound inventory sync** pushes the
live available back to each store as an absolute set through a coalesced,
backoff-guarded job queue (`store_outbound_inventory_jobs`), fired inline on stock
change and backstopped by a scheduled drain. Enabled per store via
`sync_inventory_outbound`. (Inbound store→WMS inventory updates are deliberately
**not** wired — WMS is the source of truth for stock.)

### Reporting
`security_invoker` views surfaced through the Reports page with date ranges,
per-site or all-site (admin) scope, and channel breakdown: `sales_report`
(field-picker CSV export, filterable on entered vs. sale date),
`inventory_report` (on-hand/available/reserved/layby + cost valuation),
`packaging_cost_report`, `shipping_cost_report`, `billing_report`, plus storefront
reimbursement cost views.

### Monitoring
Sentry is wired for client, server, and edge runtimes
(`instrumentation*.ts`, `sentry.*.config.ts`) and receiving errors in production.

### Settings & administration
Manage sites, categories, packaging types/costs/stock, and integrations.
Role-based access (admin vs staff) governs configuration and deletes.

### Authentication
Email/password auth (sign-up, login, callback, error pages) with SSR session
handling and route protection via middleware and the app-group server layout.

---

## Key design decisions

These are documented inline in the migrations and shape the schema:

1. **No variant tier below the product** — the sellable atomic unit is the child
   SKU (product × site). Store variants map directly to child SKUs.
2. **Customers are first-class but lightweight.**
3. **Materialized levels + append-only ledger** — `available` is always derived,
   never hand-edited; every move is double-entered into the ledger.
4. **Every order belongs to a fulfillment group** so combined-order costs are
   never double-counted.
5. **Holds are an orthogonal flag**, not a status, so they compose with the
   lifecycle.
6. **Site-scoped RLS** — staff are restricted to their assigned site(s) via
   `can_access_site`; admins roll up across all sites.
7. **Store sync is idempotent both ways** — inbound dedupes on external id,
   outbound pushes an absolute set so retries converge. Parent bulk is never
   store-mapped and can never be pushed.

---

## Project structure

```
app/
  (app)/                    authenticated app group
    dashboard/              operations overview
    inventory/              on-hand/available per SKU, by-parent, intake/allocation
    orders/                 create, edit, hold, combine, fulfill + payments
    packing/                pick lists, pick runner, wave, packaging editor, pack confirm
    catalog/                products, child SKUs, categories, duplicates, merge, reparent
    reports/                sales, inventory, packaging, shipping, billing + export
    integrations/           shopify + woocommerce connections and import
    settings/               sites, categories, packaging (types + stock), integrations
  api/
    shopify/webhooks/       Shopify webhook receiver + worker
    woocommerce/webhooks/   WooCommerce webhook receiver + worker
    store-sync/outbound/    scheduled outbound inventory drain
  auth/                     login, sign-up, callback, error
components/                 app shell, sidebar nav, shared UI (shadcn/ui)
lib/
  supabase/                 client / server / admin / proxy helpers
  catalog|inventory|orders/ domain types & logic (incl. weight parsing)
  shopify|woocommerce/      store normalizers, order import, product sync
  store-sync/               outbound drain, jobs, queue
  format.ts, utils.ts
supabase/
  migrations/               numbered schema + logic migrations (.up.sql)
  rollback/                 paired down migrations
  tests/                    pgTAP suite (00_smoke … 23_merge_weight_variants)
  seed.sql, config.toml
e2e/                        Playwright specs + fixtures
.github/workflows/ci.yml    pgTAP + lint + typecheck + Vitest, then deploy on main
```

---

## Local development

Prerequisites: Node.js, pnpm 10, and the Supabase CLI (with Docker).

```bash
pnpm install                 # install dependencies
supabase db start            # start local Postgres, apply migrations + seed
pnpm dev                     # run Next.js on http://localhost:3000
```

Environment variables required for the app and integrations:

| Var | Purpose |
|-----|---------|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase client |
| `SUPABASE_SERVICE_ROLE_KEY` | server-only privileged operations (webhook workers, drain) |
| `SHOPIFY_WEBHOOK_SECRET`, `WOOCOMMERCE_WEBHOOK_SECRET` | inbound webhook signature verification |
| `STORE_SYNC_PUBLIC_URL`, `STORE_SYNC_WORKER_SECRET` | worker callback URL + shared secret |
| `QSTASH_TOKEN`, `QSTASH_URL`, `UPSTASH_REDIS_REST_TOKEN`, `UPSTASH_REDIS_REST_URL` | outbound job queue / schedule |
| `CRON_SECRET` | authorizes the scheduled outbound drain |
| `NEXT_PUBLIC_SCANNING_ENABLED` | feature flag for barcode scan-to-pick |

After first sign-up, promote your user to `admin` in the `profiles` table.

Useful commands:

```bash
pnpm build           # production build
pnpm lint            # eslint
pnpm typecheck       # tsc --noEmit
pnpm test            # Vitest unit tests
pnpm test:e2e        # Playwright E2E
supabase test db     # run the pgTAP suite
supabase db reset    # rebuild local DB from migrations + seed
```

---

## Testing

OrbisTrack's correctness-critical logic lives in the database, so the primary
suite is **pgTAP** running against a fresh Supabase instance, complemented by
**Vitest** for pure application logic and **Playwright** for end-to-end flows. All
three run in CI on every push and pull request via `.github/workflows/ci.yml`
(which starts a local Supabase to apply migrations + seed, runs `supabase test
db`, then `pnpm lint`, `pnpm typecheck`, and `pnpm test`); migrations deploy to
production only after the suites pass on `main`.

**pgTAP suite (`supabase/tests/`, 00–23)** covers the guarded database logic:
inventory reserve/release/consume, layaway, receive, adjust and overselling
guards; pick-fee math and schedule resolution; order payments; order status
transitions and their inventory side-effects; RLS by role; `create_order`
end-to-end; packaging usage and `pack_group`; Shopify + WooCommerce variant→SKU
idempotent mapping; cost/inventory sync; secret lockdown; COGS snapshotting;
SKU-level unflatten; duplicate-product merge (incl. weight-aware); shipping;
backorders; packaging stock; outbound inventory sync (enqueue, coalescing,
live-available claim, backoff, failure cap, supersede); parent allocation; intake
allocation; and weight variant sync + backfill.

**Vitest (`lib/**/*.test.ts`)** covers the formatters, both store normalizers,
weight parsing, and pick aggregation.

**Playwright (`e2e/`)** covers the pack → ship flow with an authenticated
fixture.

### Recommended testing practices

- **Write a pgTAP test alongside every new RPC or constraint** — assert both the
  happy path and that the guard rejects the invalid transition.
- **Test concurrency on inventory** — exercise `FOR UPDATE` serialization on the
  same SKU to prove overselling is impossible under parallel moves.
- **Assert ledger ↔ level consistency** — the sum of ledger deltas for a SKU
  should equal its current level (a good invariant, and the basis for the planned
  reconciliation job).
- **Snapshot/immutability tests** — changing a fee schedule or packaging cost
  after a charge must not alter the previously recorded amount.
- **RLS regression tests** — assert staff cannot delete and cannot cross site
  boundaries.

### Not yet present

- **Webhook contract tests** that replay recorded Shopify/Woo payloads against the
  webhook routes and assert idempotency (the RPC layer is covered by pgTAP; the
  HTTP push/import path is not).
- **Migration round-trip tests** that apply each `up` then its `rollback/*.down`
  to catch irreversible migrations.

---

## Roadmap — planned features

The picking-efficiency backlog ([`PICKING-BACKLOG.md`](./PICKING-BACKLOG.md)) is
largely delivered: **bin/location tracking**, **interactive pick confirmation**
(`pick_progress`), and **barcode scan-to-pick** are built, and a **wave** view
exists. Remaining and future work:

- **Level ↔ ledger reconciliation job** — a scheduled check that
  `inventory_levels` equals the ledger sum per SKU (and parent grams vs. child
  units), alerting on drift. The durable fix against silent desync.
- **Webhook staleness recovery** — scheduled `syncPastOrders` backfill plus
  webhook re-registration, since platforms auto-disable webhooks after repeated
  delivery failures.
- **Persisted wave picking (v2)** — a `pick_waves` table with a put-wall sort step.
- **Per-client fee schedules and billing** (the `client_id` column is reserved on
  `fee_schedules`) and client-facing reimbursement invoicing.
- **Multi-package shipping with rate shopping** (the `shipments`/`packages`
  structure already supports >1 package per order).
- **Additional store channels** beyond Shopify and WooCommerce.
- **Customer-facing or operations dashboards** built on the reporting views.

---

## Future optimizations

**Performance**
- **Cover the hot query paths with composite indexes** — e.g. orders by
  `(site_id, status)`; verify the pick-list aggregation and report views are
  index-supported as volume grows.
- **Materialize the reporting views** (or back them with summary tables refreshed
  on fulfillment) once `sales_report`/`inventory_report` scan large histories;
  the `security_invoker` views recompute on every read today.
- **Paginate and server-stream large lists** (inventory, orders, audit log) using
  keyset pagination rather than `OFFSET`, and lean on RSC streaming.
- **Batch store sync** — process webhook payloads in bulk upserts to keep worker
  responses fast and within timeout.

**Data integrity & scale**
- **Partition or archive the ledger and audit_log** by time once they grow, with
  periodic snapshot rows so current levels never require a full ledger scan.
- **Ship the reconciliation job** that periodically asserts `inventory_levels`
  equals the ledger sum and flags drift (tracked in the roadmap and go-live list).
- **Enforce category-cycle prevention in the database** (recursive CHECK / trigger)
  rather than only in the app layer.

**Developer experience & reliability**
- **Type generation from the database** (`supabase gen types typescript`) to keep
  `lib/**/types.ts` in lockstep with the schema and catch contract drift at build.
- **Idempotency keys** on any remaining webhook/order-creation paths not yet keyed.
- **Sentry alerting** on failed inventory transitions and webhook worker errors
  (Sentry ingestion is live; alert rules are the next step).

**UX**
- **Optimistic UI** on inventory adjustments and order edits with server
  reconciliation.
- **Offline-tolerant picker screens** — the pick/pack team works on phones; the
  interactive runner exists, offline progress saving is the next refinement.

---

## Security model

- **Authentication:** Supabase Auth (email/password), SSR session handling via
  `@supabase/ssr`, route protection in `middleware.ts` and the `(app)` server
  layout.
- **Authorization:** Row Level Security on every table, site-scoped via
  `can_access_site`. Authenticated users read and write operational data for their
  site(s); deletes and configuration tables (sites, categories, packaging types,
  fee schedules, profiles) are admin-only. The inventory ledger and audit log are
  append-only for everyone.
- **Defense in depth:** business rules are enforced in the database via CHECK
  constraints and guarded functions, so even a direct database connection cannot
  oversell stock or skip a transition guard.
- **Secrets:** store credentials live in `store_secrets`, locked down at the
  database level and never exposed to client roles; the service-role key is used
  only server-side in webhook workers and the outbound drain.
- **Webhook integrity:** inbound Shopify/WooCommerce webhooks are signature-verified
  against their shared secrets before processing.
- **Auditability:** the generic `audit_log` captures before/after snapshots of
  every operational mutation, and the inventory ledger records who moved what,
  when, why, and against which reference.
```
