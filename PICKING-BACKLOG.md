# Picking & Packing — Feature Backlog

Engineering specs for four pick/packer efficiency features, grounded in the
current codebase. Ordered by recommended build sequence; each builds on the one
before it.

**Current baseline (June 2026):** Picking is per fulfillment group. The pick
list (`app/(app)/packing/[id]/pick-list/page.tsx`) aggregates line items by
child SKU across a group's active orders and **sorts by SKU code** — its own
comment notes *"No bin locations tracked, so sort by SKU."* It is print-only.
Order status moves `created ↔ picking ↔ packed` via the `set_order_status` RPC
(label-only); `fulfill_order` / `cancel_order` are the terminal, inventory-
moving transitions. Groups close (`fulfillment_groups.status → fulfilled`) when
all their orders are fulfilled.

| # | Feature | Effort | Depends on |
|---|---------|--------|-----------|
| 1 | Bin / location tracking | S | — |
| 2 | Interactive pick confirmation | M | 1 (nice-to-have) |
| 3 | Barcode / SKU scan | M | 2 |
| 4 | Batch / wave picking | L | 1, 2 |

---

## 1. Bin / location tracking

**Problem.** Pickers have no location data, so the pick list falls back to
alphabetical-by-SKU order. That's a scavenger hunt, not a walking route.

**Value.** A location per SKU lets the pick list sort by physical position —
the single biggest time-saver here. Turns picking into one efficient pass.

**Schema.** A child SKU is already one product at one site, so location belongs
on it.

```sql
-- migration: add bin location to child_skus
alter table public.child_skus add column bin_location text;
create index child_skus_bin_idx on public.child_skus (site_id, bin_location);
```

Free-text (`"A-12-3"`) is enough for v1 — no structured aisle/shelf table yet.
Existing RLS/grants on `child_skus` already cover the new column.

**Backend / actions.**
- `app/(app)/catalog/actions.ts` → extend `ChildSkuInput`, `createChildSku`,
  `updateChildSku` to read/write `bin_location` (trim, `|| null`).
- No RPC needed; it's a plain column.

**Frontend.**
- `app/(app)/catalog/[id]/child-sku-manager.tsx` — add a **Bin** field to the
  add/edit drafts and a Bin column in the table.
- `app/(app)/catalog/[id]/page.tsx` and the `ChildSku` type — carry
  `bin_location` through the query and mapping.
- `app/(app)/packing/[id]/pick-list/page.tsx` — add `bin_location` to the
  `child_skus` select, include it in the `PickLine` type, and change the sort to
  **bin first (blanks last), then SKU, then name**. Add a Bin column to the
  printed table.
- Optional: surface bin in the inventory list (`app/(app)/inventory`).

**Sequencing / notes.** Ship first — small, self-contained, immediate win, and
it makes the routes for features 2 and 4 actually efficient.

**Open questions.** Multiple bins per SKU (overflow/pick-face)? Structured
aisle/shelf/bin vs free text? Both are post-v1.

---

## 2. Interactive pick confirmation

**Problem.** The pick list is print-only. Pickers work off paper and there's no
record of what's been picked until the order is packed/fulfilled.

**Value.** A mobile tap-to-check-off view that writes progress back: live
status, no lost paper, and the data foundation that scanning (feature 3) and
waves (feature 4) build on.

**Schema.** Track progress at the same grain the pick list aggregates — per
group, per child SKU.

```sql
create table public.pick_progress (
  group_id     uuid not null references public.fulfillment_groups(id) on delete cascade,
  child_sku_id uuid not null references public.child_skus(id)         on delete restrict,
  qty_picked   integer not null default 0 check (qty_picked >= 0),
  picked_by    uuid references public.profiles(id),
  updated_at   timestamptz not null default now(),
  primary key (group_id, child_sku_id)
);
alter table public.pick_progress enable row level security;
-- site-scoped via the group, mirroring packaging_usage policies:
create policy pick_progress_rw on public.pick_progress for all
  using (exists (select 1 from public.fulfillment_groups g
                 where g.id = group_id and public.can_access_site(g.site_id)))
  with check (exists (select 1 from public.fulfillment_groups g
                      where g.id = group_id and public.can_access_site(g.site_id)));
```

**Backend / RPCs.** Keep guarded transitions consistent with the existing
state machine (`20260622000007_order_lifecycle.sql`):
- `set_pick_qty(p_group_id, p_child_sku_id, p_qty)` — upsert progress (clamp to
  the required qty); on first pick, move the group's `created` orders →
  `picking` via the existing `set_order_status` path.
- Optional `complete_picking(p_group_id)` — assert every required SKU is fully
  picked, then advance orders `picking → packed` (or just unlock the existing
  pack step). Reuse `pack_group` for the pack side; this only gates it.
- Server actions in `app/(app)/packing/actions.ts`.

**Frontend.**
- New `app/(app)/packing/[id]/pick/page.tsx` (+ a client `pick-runner.tsx`):
  mobile-first, large tap targets, one row per SKU showing **bin** (feature 1),
  product, SKU, required vs picked, with `+/−` and a "pick all" tap. Progress
  bar; "Picking complete" enables packing.
- Keep the print view as a fallback; link both from
  `app/(app)/packing/[id]/page.tsx`.
- Reuse the group's existing SKU-aggregation logic from the pick-list page
  (extract the `byKey` reducer into a shared helper).

**Sequencing / notes.** Do after bin tracking so the interactive list sorts by
route. This is the keystone feature — 3 and 4 assume `pick_progress` exists.

**Open questions.** Partial picks / short-pick handling (out of stock mid-pick)?
One picker per group or concurrent (the `picked_by` + `updated_at` support a
soft lock later)?

---

## 3. Barcode / SKU scan

**Problem.** Manual matching of SKU → line is slow and error-prone; mis-picks
slip through.

**Value.** Scan-to-pick (scan confirms the right SKU and increments its picked
qty) and scan-to-pack (validate each item against the expected set) cut
mis-picks. Pairs naturally with the searchable SKU field already shipped (the
Combobox already filters on SKU via its `keywords`).

**Schema.** SKU code may differ from the scannable barcode (UPC/EAN), so add an
explicit barcode:

```sql
alter table public.child_skus add column barcode text;
create index child_skus_barcode_idx on public.child_skus (site_id, barcode);
```

Match scans against `barcode` first, then fall back to `sku`.

**Backend.** Mostly client-side matching, but add a small lookup used by both
pick and pack:
- `resolve_scan(p_group_id, p_code)` (or a server action) → returns the matching
  `child_sku_id` within the group's required items, or a "not in this group"
  signal. On a pick match, call `set_pick_qty` (feature 2).

**Frontend.**
- A reusable `ScanInput` component: most handheld scanners are keyboard-wedge
  devices, so capture rapid keystrokes ending in Enter into a focused input;
  debounce, then resolve. Also expose manual entry for damaged labels.
- Wire into the interactive pick page (feature 2): a scan increments the matched
  SKU; unknown/!-in-group scans flash an error.
- Wire into `app/(app)/packing/[id]/pack-confirm.tsx`: scan-to-pack validation
  before `pack_group` — every required unit must be scanned (or overridden by an
  operator) to pack.
- Catalog: add a Barcode field next to Bin in `child-sku-manager.tsx`.

**Sequencing / notes.** Build on feature 2's `pick_progress` and pick page.
Optional camera-based scanning (no hardware scanner) is a later enhancement.

**Open questions.** Hardware scanners vs phone camera? Override flow when a
label won't scan — who can force-confirm?

---

## 4. Batch / wave picking

**Problem.** Picking is one group at a time, so a picker walks the floor once
per group even when many small groups overlap.

**Value.** Aggregate SKUs across **many** groups into one combined pick, then
sort the picked stock back out by group/order (put-wall). One walk, many orders.

**Schema.** Two tiers:
- **v1 (ephemeral):** no schema — select multiple open groups in the UI and
  generate a combined list on the fly.
- **v2 (persisted waves):** so a wave can be owned/assigned and progress tracked.

```sql
-- v2
create table public.pick_waves (
  id         uuid primary key default gen_random_uuid(),
  site_id    uuid not null references public.sites(id),
  status     text not null default 'open' check (status in ('open','picking','sorted','done')),
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);
create table public.pick_wave_groups (
  wave_id  uuid not null references public.pick_waves(id) on delete cascade,
  group_id uuid not null references public.fulfillment_groups(id) on delete restrict,
  primary key (wave_id, group_id)
);
-- RLS: site-scoped via site_id / the joined group, per the existing pattern.
```

With v2, `pick_progress` (feature 2) gains an optional `wave_id` so a wave is
picked as one unit, then sorted to groups.

**Backend.**
- Aggregation: generalize the pick-list `byKey` reducer to take a **set** of
  group ids and sum across them, keeping a per-group/per-order breakdown for the
  sort stage.
- v2 RPCs: `create_wave(site_id, group_ids[])`, `add/remove_wave_group`,
  `close_wave`. Guard that all groups share one site and are still open.

**Frontend.**
- `app/(app)/packing/page.tsx` — add multi-select checkboxes on open groups
  (same site) and a "Pick as wave" action.
- New `app/(app)/packing/wave/[id]` (or a query-param combined view): the
  consolidated, bin-sorted pick list (feature 1), then a **sort/put** screen
  that lists, per SKU, how many go to each group/order.
- Reuse the interactive runner (feature 2) for check-off across the wave.

**Sequencing / notes.** Largest scope; do last. Leans on feature 1 (route sort
makes a big wave worthwhile) and feature 2 (interactive check-off across the
wave). Start with v1 ephemeral to validate the workflow before persisting waves.

**Open questions.** Wave size cap? Same-site-only (almost certainly yes, since
inventory is per site)? Put-wall/sort UX — by group or by order?

---

### Cross-cutting

- **Mobile-first:** the pick/pack team uses phones (noted in the Select
  component). Every new picker screen should be touch-first with large targets.
- **Reuse, don't fork:** extract the pick-list SKU-aggregation reducer into a
  shared helper now (e.g. `lib/packing/aggregate.ts`); features 2 and 4 both
  need it.
- **Stay on the guarded state machine:** all status/inventory moves go through
  RPCs (`set_order_status`, `fulfill_order`, `pack_group`, …), never bare
  client updates — keep new transitions in that pattern.
