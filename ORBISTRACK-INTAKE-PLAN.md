# OrbisTrack — Inventory Intake & Allocation Flow (Implementation Plan)

**Status:** Draft for review · **Date:** 2026-07-01 · **Owner:** J

Warehouse receives bulk product into a **Parent SKU** (bulk grams), then allocates
that bulk into per-client sellable **Child SKUs** (jars at 3.5g / 7g / 14g / 28g).
Saving an allocation immediately pushes the new sellable quantity to each client's
ecommerce store. Total allocated grams can never exceed the parent's available grams.

---

## 1. Decisions locked in (from review)

| # | Decision | Choice |
|---|----------|--------|
| D1 | **"Client" mapping** | **Client = Site.** Reuse existing site-scoped RLS, per-site `store_connections`, and outbound sync. No new `clients` entity. |
| D2 | **Parent bulk pool scope** | **Per warehouse/site.** Bulk grams and the unallocated pool live at a site, matching the project's location isolation. |
| D3 | **Units & conversion** | **Unit counts in, 28g/oz convention.** `1 oz = 28g`, `1 lb = 448g`. Grams consumed = `units × grams_per_unit`. Each weight child stores its `grams_per_unit` (3.5 / 7 / 14 / 28). Typical lb breakdown: 16×3.5 + 8×7 + 8×14 + 8×28 = 448g (a suggested default, not a constraint). |

---

## 2. What already exists and is reused (no rebuild)

The current schema and sync layer cover more of this flow than expected:

- **Outbound store sync = Step 6, already built** (`migration 0026`). A trigger on
  `inventory_ledger` enqueues one coalesced job per child SKU into
  `store_outbound_inventory_jobs`, pushing the child's new `available` (`on_hand − reserved`)
  to Shopify/WooCommerce. A worker (`lib/store-sync/outbound.ts`) claims jobs
  (`FOR UPDATE SKIP LOCKED`) with retry/backoff. **Because allocation writes child
  `receipt` ledger rows, the store push happens automatically.** The parent has no
  `store_variant_id`, so the parent is never synced — exactly as required.
- **Guarded inventory primitives** (`migration 0002`): `_inv_lock`, `_inv_write`,
  `receive_stock`, `adjust_stock`. Allocation reuses these to credit child on-hand.
- **Append-only ledger + generic audit** (`migration 0001`): `inventory_ledger`
  (actor, timestamp, reason, reference), `audit_log`. Satisfies most of Step 5's
  history/timestamp/employee requirements for the child side.
- **Site-scoped RLS + roles** (`migration 0004`): `admin` / `operator` / `client`,
  `user_site_access`, `can_access_site()`. Reused as-is.
- **RPC transaction pattern** (`create_order_rpc`, `apply_order_*`): allocation is
  modeled as one SECURITY-guarded RPC in the same style.

### Gaps this plan fills
1. No parent-level bulk inventory (inventory is per child only, whole units).
2. No weight/grams concept on child SKUs; `child_skus` is **one child per product
   per site** (`unique(product_id, site_id)`), which blocks 4 weight variants per client.
3. No allocation transaction, allocation history, or UoM conversion.
4. No intake/allocation UI or completion screen.

---

## 3. Data model changes

All migrations reversible (`.up.sql` + matching `rollback/*.down.sql`), per project rules.

### 3.1 Child SKU: add weight dimension  *(schema decision — needs sign-off)*
```
alter table child_skus add column grams_per_unit numeric(8,2);   -- 3.5, 7, 14, 28; null = non-cannabis
alter table child_skus add column variant_label  text;           -- "3.5g", "7g" for display
```
The existing `unique (product_id, site_id)` constraint **must be relaxed** to allow
multiple weight variants per client-site:
```
-- replace with:
unique (product_id, site_id, grams_per_unit)
```
**Impact / risk:** the catalog UI (`child-sku-manager.tsx`) currently assumes one
child per site. It needs a weight field and to allow multiple children per site.
This is the single largest ripple beyond intake itself — called out separately in §7.

### 3.2 Parent bulk inventory (new) — per product × site, in grams
```
parent_inventory (
  product_id      uuid,
  site_id         uuid,
  on_hand_grams   numeric(12,2) not null default 0,   -- unallocated bulk remaining
  allocated_grams numeric(12,2) not null default 0,   -- cumulative, for reporting
  updated_at      timestamptz,
  primary key (product_id, site_id),
  check (on_hand_grams >= 0)
)
```
**Semantics:** intake credits `on_hand_grams`. Allocation debits `on_hand_grams`
(bulk is physically broken into jars) and increments the child's `on_hand`. "Parent
inventory available" in the UI = `on_hand_grams`. `allocated_grams` is a running total
for reporting; it is *not* subtracted again.

### 3.3 Parent ledger + allocation history (new)
```
parent_inventory_ledger (   -- append-only, mirrors inventory_ledger
  id, product_id, site_id, delta_grams, reason  -- 'intake' | 'allocation' | 'transfer' | 'correction'
  reference_type, reference_id, note, actor, created_at )

allocations (               -- one per Save Allocation click (Step 5 header)
  id, product_id, site_id, total_grams, note, actor, created_at,
  idempotency_key unique )  -- guards double-submit

allocation_lines (
  allocation_id, child_sku_id, units, grams_per_unit, grams )
```
This gives Step 5 (history, timestamp, employee), Step 7 (completion summary), and
the "View Allocation History" screen a durable source, plus full `audit_log` coverage.

### 3.4 UoM conversion (new, tiny)
DB helper `to_grams(qty numeric, uom text) returns numeric` and a matching TS constant
map — `{ g:1, oz:28, lb:448 }`. Single source of truth so intake and reports agree.

---

## 4. Server flow — one guarded RPC

**`intake_receive(product_id, site_id, qty, uom, batch_no, note)`**
→ converts to grams via `to_grams`, locks + credits `parent_inventory.on_hand_grams`,
writes `parent_inventory_ledger` (`reason='intake'`). Returns new available grams.

**`allocate_parent_stock(product_id, site_id, lines[], idempotency_key, note)`** — the core, all-or-nothing:
1. Lock the `parent_inventory` row (`for update`).
2. `requested_grams = Σ (line.units × child.grams_per_unit)`.
3. **Validate** `requested_grams ≤ on_hand_grams` → else raise
   `"Total allocated inventory exceeds available Parent SKU inventory."`
4. For each line: `receive_stock(child_sku_id, units, ref_type='allocation', ref_id=allocation_id)`
   → child `on_hand`/`available` rise → outbound sync job auto-enqueued.
5. Debit `on_hand_grams`, bump `allocated_grams`, write `parent_inventory_ledger` (`reason='allocation'`).
6. Insert `allocations` + `allocation_lines`, `actor = auth.uid()`.
7. `idempotency_key` unique → a double-click can't double-allocate.

Backstops: `check (on_hand_grams >= 0)` on the table + the child `on_hand >= reserved`
check. The RPC pre-validates only for a friendlier message.

**Step 6 (sync) is emergent** — no allocation-specific sync code. Child receipts
enqueue outbound jobs; the existing worker pushes each client's store to the exact
sellable unit count. Completion screen reads job status per child.

---

## 5. UI — `Inventory → Intake Inventory` (4 screens, mobile-friendly)

1. **Select Parent** — parent dropdown (name may be non-unique → show category/site to
   disambiguate), auto-filled strain, optional batch/lot, qty + UoM select. → *Continue*.
2. **Receive confirmation** — success state, "Parent Inventory Available `448g`", *Allocate Inventory*.
3. **Allocation screen** — auto-loads every child of the parent at this site, grouped by
   **Client (site)**, weight rows with unit-count inputs. **Live summary panel**:
   Parent / Allocated / Remaining, recomputed on input, color states
   **green** (valid) · **yellow** (nearly exhausted, e.g. <10% left) · **red** (over) with
   offending fields highlighted and *Save* disabled while red. All math client-side;
   the RPC re-validates server-side.
4. **Completion** — Parent SKU, qty received, total allocated, remaining parent grams,
   # client SKUs updated, per-client website sync status (from `store_outbound_inventory_jobs`).
   Buttons: *Return to Inventory* · *View Parent SKU* · *View Allocation History*.

---

## 6. Testing (pgTAP, runs in your existing CI)

Risk-focused, developer-side (keeps team UAT light per project principle):
- Allocation never exceeds parent available grams (boundary: exactly-equal passes, +1g fails).
- Unit↔gram conversion (3.5/7/14/28; lb/oz/g intake) and 448g/lb rounding.
- Allocation is **atomic** (one bad line rolls back all) and **idempotent** (repeat key = no double-count).
- Every changed child enqueues exactly one coalesced outbound job; **parent never enqueues**.
- Parent `on_hand_grams` conservation: intake − allocations = remaining.
- RLS: staff/site scoping on parent_inventory, allocations, and the RPCs.
- **Transfer** (§8): total units conserved, parent grams unchanged, both stores enqueue.

---

## 7. Sequencing

- **A1 — Schema:** parent_inventory (+ledger), allocations (+lines), child weight columns,
  relaxed uniqueness, `to_grams`. Reversible migrations + pgTAP.
- **A2 — RPCs:** `intake_receive`, `allocate_parent_stock` + tests.
- **A3 — Catalog ripple:** update `child-sku-manager.tsx` for weight variants / multiple
  children per site. *(Do before A4 — allocation screen depends on weight children existing.)*
- **A4 — Intake UI:** the 4 screens + live summary.
- **A5 — Completion + sync status + Allocation History view.** (Sync itself already works.)
- **B — Verify** end-to-end against a seeded staging store (Supabase branch), one store at a time.

---

## 8. Future — Transfer Allocation (design sketch)

Move sellable units **between clients** without touching physical bulk. Since Client = Site
and child = product × site, a transfer moves units from client A's weight-child to client B's
same-weight child:
- RPC `transfer_allocation(product_id, from_site, to_site, grams_per_unit, units, actor)`:
  `adjust_stock(from_child, −units)` + `receive_stock(to_child, +units)` in one txn;
  `parent_inventory` untouched; write a `transfer` history row.
- Both children change → both clients' stores auto-sync via the existing outbound trigger.
- Requires a matching-weight child on the destination site (create on the fly if missing).

---

## 9. Open items to confirm before A1

1. **Relaxing `unique(product_id, site_id)`** and adding weight variants touches the live
   catalog UI and any code assuming one-child-per-site — OK to proceed? (Biggest blast radius.)
2. **"Nearly exhausted" (yellow) threshold** — propose <10% of parent remaining. Agree?
3. **Partial allocation** — leaving grams unallocated (e.g. 56g remaining) stays in the pool
   for a later allocation. Confirmed as intended?
4. **Intake UoM list** — lb/oz/g only, or also kg? (Affects `to_grams` map.)
