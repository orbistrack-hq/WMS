# OrbisTrack — Warehouse Management System

OrbisTrack is a multi-site warehouse management system (WMS) for running catalog,
inventory, order, picking/packing, shipping, billing, and reporting workflows out
of one application. It is built for 3PL-style operations where stock, fees, and
fulfillment must be tracked per physical site and where orders can arrive both
manually and from connected e-commerce stores (Shopify today).

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

OrbisTrack is in active development (version `0.1.0`). Work is organized into
three milestones:

| Milestone | Scope | Hours | Window |
|-----------|-------|-------|--------|
| 1 — Foundation, Catalog & Inventory | Schema, RLS, inventory state machine, catalog, inventory UI | 20 | Jun 22 – Jun 25 |
| 2 — Orders, Packing & Shipping | Order lifecycle, packing, packaging costs, pick lists | 25 | Jun 26 – Jun 30 |
| 3 — Integrations, Reporting, Testing & Go-Live | Shopify sync, reporting views, hardening, launch | 25 | Jul 1 – Jul 6 |

Milestones 1 and 2 are substantially built (catalog, inventory, orders, packing,
Shopify import, and reporting views all exist in the codebase). Milestone 3 work
— deeper integration sync, reporting surfaces, and the picking-efficiency
backlog — is in progress.

---

## Tech stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 16 (App Router, React Server Components) |
| UI | React 19, Tailwind CSS v4, shadcn/ui, Radix/Base UI primitives, lucide-react icons |
| Backend / DB | Supabase (PostgreSQL 15+) with Row Level Security |
| Auth | Supabase Auth (email/password) via `@supabase/ssr` |
| Business logic | PostgreSQL functions (PL/pgSQL) called as RPCs from Next.js server actions |
| Migrations / local stack | Supabase CLI (`supabase db`, `supabase test db`) |
| Testing | pgTAP (database test suite) |
| CI | GitHub Actions (pgTAP suite on every push / PR) |
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
- `sites` — physical warehouse locations. Inventory and child SKUs are per-site.

**Catalog**
- `categories` — multi-level via adjacency list (`parent_id`); cycle prevention
  in the app layer.
- `products` — the master/parent product. Names are intentionally not unique.
- `child_skus` — the atomic sellable unit: one product at one site, with its own
  `sku`, `price`, `cost`, and `store_variant_id` for external mapping. Unique per
  `(product_id, site_id)`; SKU codes unique per site.

**Inventory**
- `inventory_levels` — materialized per-SKU counters: `on_hand`, `reserved`,
  `layby`, and a generated `available = on_hand − reserved`. CHECK constraints
  prevent negative stock and overselling (`on_hand >= reserved`). Created
  automatically per child SKU via trigger.
- `inventory_ledger` — append-only movement log. Every level change writes a
  paired ledger row recording the delta, reason (`order_reserve`,
  `order_consume`, `layaway_remove`, `receipt`, `manual_adjustment`, …),
  reference, note, and actor.

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
  `entered_at`).
- `order_line_items` — per child SKU, with quantity, unit price, discount, tax.

**Packaging & shipping**
- `packaging_types` — boxes, labels, jars, vacuum bags, etc., each with a unit cost.
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

**Audit**
- `audit_log` — generic before/after JSON snapshots written by an `audit_row`
  trigger attached to the operational tables.

---

## Current features

### Catalog management
Full product catalog with multi-level categories, parent products, and per-site
child SKUs. Includes a category manager, product create/edit forms, child-SKU
management per product, **duplicate detection and merge** (both automatic and
manual merge of duplicate products), and SKU **reparenting** between products.

### Inventory
Per-SKU on-hand / reserved / available / layby visibility with site-scoped
filtering. Manual stock adjustments and receipts flow through guarded functions
and are fully recorded in the append-only ledger. A per-SKU detail view exposes
an adjustment panel.

### Inventory state machine
Atomic, concurrency-safe stock primitives:
- **Standard:** `reserve → release` (on cancel) / `consume` (on fulfill).
- **Layaway:** `book` (removes from on-hand now) → `cancel` / `consume`.
- **Stock-in / correction:** `receive`, `adjust` (signed, note-required).

Each locks the level row, validates with clear error messages, and writes level +
ledger together. Order-level orchestrators (`apply_order_creation`,
`apply_order_cancellation`, `apply_order_fulfillment`) branch on order type and
apply the right primitive to every line.

### Orders
Create orders (via the `create_order` RPC), edit, hold/un-hold, and move through
the lifecycle. Standard orders reserve stock at creation; layaway orders remove
it from on-hand immediately. Supports post-dated sales, per-order ship-to
addresses, discounts, tax, customer attachment, and order payments. Cancellation
and fulfillment release or consume stock through the guarded transitions.

### Fulfillment groups & order combining
Orders sharing a customer/ship-to are grouped so packaging, box/label, and
shipping costs are counted once across combined orders.

### Picking & packing
A per-group pick list (`packing/[id]/pick-list`) aggregates line items by child
SKU across the group's active orders and prints for the floor. Packing records
packaging usage against the group (`record_packaging_usage`), with `pack_group`
advancing the workflow and snapshotting packaging costs. A packaging editor and
pack-confirm step are included.

### Billing & pick fees
Effective-dated fee schedules resolve the correct rate as of the order's
fulfillment date. `calc_order_pick_fee` / `charge_order_pick_fee` /
`charge_group_pick_fees` compute and record the first-unit-premium-once-per-order
pricing, snapshotting the rate onto each charge.

### Shipping
Shipments and packages per group, with carrier, service level, estimated/actual
cost, tracking number, and weight.

### Shopify integration
Self-serve store connection, product/variant import, and order import via
webhooks (`app/api/shopify/webhooks/route.ts`). Each Shopify **variant** maps
idempotently to a WMS product + child SKU at the connected store's site (keyed by
`store_variant_id`) — Shopify owns name/price/SKU, WMS owns cost. Includes
cost/inventory sync, COGS snapshotting, secret lockdown, and SKU-level
unflattening.

### Reporting
Five `security_invoker` views: `sales_report`, `inventory_report`,
`packaging_cost_report`, `shipping_cost_report`, and `billing_report`, surfaced
through the Reports page.

### Settings & administration
Manage sites, categories, packaging types and costs, and integrations. Role-based
access (admin vs staff) governs configuration and deletes.

### Authentication
Email/password auth (sign-up, login, callback, error pages) with SSR session
handling and route protection via middleware and the app-group server layout.

---

## Key design decisions

These are documented inline in the migrations and shape the schema:

1. **No variant tier below the product** — the sellable atomic unit is the child
   SKU (product × site). Shopify variants map directly to child SKUs.
2. **Customers are first-class but lightweight.**
3. **Materialized levels + append-only ledger** — `available` is always derived,
   never hand-edited; every move is double-entered into the ledger.
4. **Every order belongs to a fulfillment group** so combined-order costs are
   never double-counted.
5. **Holds are an orthogonal flag**, not a status, so they compose with the
   lifecycle.
6. **Role-based RLS** — staff currently see all sites; a later migration adds
   site-scoped RLS (`can_access_site`).

---

## Project structure

```
app/
  (app)/                  authenticated app group
    dashboard/            operations overview
    inventory/            on-hand/available per SKU + adjust panel
    orders/               create, edit, hold, combine, fulfill + payments
    packing/              pick lists, packaging editor, pack confirm
    catalog/              products, child SKUs, categories, duplicates, merge
    reports/              sales, inventory, packaging, shipping, billing
    integrations/shopify/ store connections + import
    settings/             sites, categories, packaging, integrations
  api/shopify/webhooks/   Shopify webhook receiver
  auth/                   login, sign-up, callback, error
components/               app shell, sidebar nav, shared UI (shadcn/ui)
lib/
  supabase/               client / server / admin / proxy helpers
  catalog|inventory|orders|shopify/  domain types & import logic
  format.ts, utils.ts
supabase/
  migrations/             numbered schema + logic migrations (.up.sql)
  rollback/               paired down migrations
  tests/                  pgTAP suite (00_smoke … 13_merge_duplicate_products)
  seed.sql, config.toml
.github/workflows/ci.yml  pgTAP CI pipeline
```

---

## Local development

Prerequisites: Node.js, pnpm 10, and the Supabase CLI (with Docker).

```bash
pnpm install                 # install dependencies
supabase db start            # start local Postgres, apply migrations + seed
pnpm dev                     # run Next.js on http://localhost:3000
```

Environment variables (Supabase project URL, anon key, service role key, and
Shopify credentials) are required for the app and integrations. After first
sign-up, promote your user to `admin` in the `profiles` table.

Useful commands:

```bash
pnpm build           # production build
pnpm lint            # eslint
supabase test db     # run the pgTAP suite
supabase db reset    # rebuild local DB from migrations + seed
```

---

## Testing

OrbisTrack's correctness-critical logic lives in the database, so the primary
test suite is **pgTAP** running directly against a fresh Supabase instance. The
suite lives in `supabase/tests/` and is executed in CI on every push and pull
request via `.github/workflows/ci.yml` (which runs `supabase db start` to apply
all migrations + seed, then `supabase test db`).

Current test files:

| File | Covers |
|------|--------|
| `00_smoke.sql` | Schema/objects exist, basic sanity |
| `01_inventory.sql` | Reserve/release/consume, layaway, receive, adjust; overselling guards |
| `02_pick_fee.sql` | First-unit-premium pick-fee math + schedule resolution |
| `03_payments.sql` | Order payment recording |
| `04_lifecycle.sql` | Order status transitions and inventory side-effects |
| `05_rls.sql` | Row Level Security policies (read/write/delete by role) |
| `06_create_order.sql` | `create_order` RPC end-to-end |
| `07_packing.sql` | Packaging usage + `pack_group` |
| `08_shopify_variant.sql` | Variant → product/SKU idempotent mapping |
| `09_shopify_inventory_cost.sql` | Shopify cost/inventory sync |
| `10_shopify_secrets_lockdown.sql` | Secret access restrictions |
| `11_cogs.sql` | COGS snapshotting |
| `12_shopify_unflatten.sql` | SKU-level unflattening |
| `13_merge_duplicate_products.sql` | Duplicate-product merge |

### Recommended testing practices

- **Write a pgTAP test alongside every new RPC or constraint.** Each guarded
  function should have a test that asserts both the happy path and that the guard
  rejects the invalid transition (e.g. cannot reserve more than available).
- **Test concurrency on inventory.** Add tests that exercise `FOR UPDATE`
  serialization on the same SKU to prove overselling is impossible under
  parallel moves.
- **Assert ledger ↔ level consistency.** After any move, the sum of ledger deltas
  for a SKU should equal its current level — a good invariant to test.
- **Snapshot/immutability tests.** Verify that changing a fee schedule or
  packaging cost after a charge does not alter the previously recorded amount.
- **RLS regression tests** as roles and site-scoping evolve, asserting staff
  cannot delete and cannot cross site boundaries once site-scoped RLS lands.

### Suggested additions (not yet present)

- **Application-layer tests** for server actions and React components
  (e.g. Vitest + React Testing Library) to cover form validation and the
  action → RPC contract.
- **End-to-end tests** (Playwright) for critical flows: create order → pick →
  pack → fulfill, and Shopify webhook → order import.
- **Webhook contract tests** that replay recorded Shopify payloads against the
  webhook route and assert idempotency.
- **Migration round-trip tests** that apply each `up` then its `rollback/*.down`
  to catch irreversible migrations.

---

## Roadmap — planned features

A detailed, codebase-grounded engineering spec for picking efficiency lives in
[`PICKING-BACKLOG.md`](./PICKING-BACKLOG.md). Summary, in recommended build order:

1. **Bin / location tracking (S).** Add `bin_location` to child SKUs so the pick
   list sorts by physical position instead of alphabetically by SKU — the single
   biggest picking time-saver.
2. **Interactive pick confirmation (M).** A mobile, tap-to-check-off pick view
   backed by a new `pick_progress` table, writing live progress per group/SKU and
   driving the `created → picking → packed` transitions. Foundation for scanning
   and waves.
3. **Barcode / SKU scan (M).** Add a `barcode` column; scan-to-pick and
   scan-to-pack validation via a keyboard-wedge `ScanInput` to cut mis-picks.
4. **Batch / wave picking (L).** Aggregate SKUs across many groups into one
   combined pick with a put-wall sort step (ephemeral v1, persisted `pick_waves`
   in v2).

Beyond the picking backlog, the schema already anticipates:

- **Site-scoped RLS** so staff are restricted to their own site(s).
- **WooCommerce channel** (already a valid `channel` value) and additional
  marketplace integrations.
- **Per-client fee schedules and billing** (the `client_id` column is reserved on
  `fee_schedules`) to support true 3PL multi-tenancy and client invoicing.
- **Multi-package shipping with rate shopping** (the `shipments`/`packages`
  structure already supports >1 package per order).
- **Customer-facing or operations dashboards** built on the reporting views.

---

## Future optimizations

**Performance**
- **Cover the hot query paths with composite indexes** — e.g. orders by
  `(site_id, status)`, line items already indexed by order; verify the pick-list
  aggregation and report views are index-supported as volume grows.
- **Materialize the reporting views** (or back them with summary tables refreshed
  on fulfillment) once `sales_report`/`inventory_report` scan large histories;
  the `security_invoker` views recompute on every read today.
- **Paginate and server-stream large lists** (inventory, orders, audit log) using
  keyset pagination rather than `OFFSET`, and lean on RSC streaming.
- **Batch Shopify sync** — process webhook payloads in bulk upserts and move
  heavy imports to a background queue / Supabase Edge Function to keep webhook
  responses fast and within timeout.

**Data integrity & scale**
- **Partition or archive the ledger and audit_log** by time once they grow, with
  periodic snapshot rows so current levels never require a full ledger scan.
- **Add a reconciliation job** that periodically asserts `inventory_levels` equals
  the ledger sum and flags drift.
- **Enforce category-cycle prevention in the database** (recursive CHECK / trigger)
  rather than only in the app layer.

**Developer experience & reliability**
- **Type generation from the database** (`supabase gen types typescript`) to keep
  `lib/**/types.ts` in lockstep with the schema and catch contract drift at build.
- **Add app-layer and E2E test tiers** (see Testing) and run them in CI alongside
  pgTAP.
- **Idempotency keys** on webhook and order-creation paths to make retries safe.
- **Observability** — structured logging and error tracking around server actions
  and the webhook route, plus alerting on failed inventory transitions.

**UX**
- **Optimistic UI** on inventory adjustments and order edits with server
  reconciliation.
- **Mobile-first picker screens** (the backlog notes the pick/pack team uses
  phones) with large tap targets and offline-tolerant progress saving.

---

## Security model

- **Authentication:** Supabase Auth (email/password), SSR session handling via
  `@supabase/ssr`, route protection in `middleware.ts` and the `(app)` server
  layout.
- **Authorization:** Row Level Security on every table. Authenticated users can
  read and write operational data; deletes and configuration tables (sites,
  categories, packaging types, fee schedules, profiles) are admin-only. The
  inventory ledger and audit log are append-only for everyone.
- **Defense in depth:** business rules are enforced in the database via CHECK
  constraints and guarded functions, so even a direct database connection cannot
  oversell stock or skip a transition guard.
- **Secrets:** Shopify credentials are locked down at the database level
  (migration `…_lock_shopify_secrets`) and never exposed to client roles.
- **Auditability:** the generic `audit_log` captures before/after snapshots of
  every operational mutation, and the inventory ledger records who moved what,
  when, why, and against which reference.
```