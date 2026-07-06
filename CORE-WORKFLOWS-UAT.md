# Core Workflows — Staging Sign-off (Phase A)

**Goal:** prove the money-critical order + inventory workflows end to end in the real
app before go-live — the reservation lifecycle (reserve → release → consume), the
create→pick→pack→ship→fulfill flow, combine, hold, layaway, post-dating, manual
adjustments, store import/push, reports, and site-scoped access. Kept to a
~12-scenario sign-off per the project's lightweight-UAT principle: **one shadow day
on one location, or this checklist — never full double-entry.**

Run on **staging** (a Supabase branch seeded with a real catalog slice). Nothing here
touches production. Two testers ideal: one drives the app, one watches the numbers.

Legend: initial the ✅ box only when **Expected** matches exactly. Any mismatch → stop,
note it under _Issues_, don't sign off.

---

## 0. Setup (once)

1. **Isolated DB with data.**
   ```
   supabase db reset      # applies all migrations + seed.sql
   supabase test db       # pgTAP suite green (reservations, lifecycle, packing, shipping, sync, RLS)
   ```
   Then seed a small real-catalog slice: 2–3 sites, a handful of child SKUs each with
   known on-hand counts. Record the starting numbers — you'll assert against them.
2. **Accounts:** one `admin`, one `operator` (packing team, all sites), and one
   `client` bound to a single site via `user_site_access` (for scenario 12). Use
   `scripts/provision-user.sql`.
3. **One store connection** (staging Shopify or Woo) for scenarios 9–10, outbound
   enabled on that one store only.

**Pre-flight — snapshot the starting levels for one SKU you'll use throughout:**
```sql
select cs.sku, il.on_hand, il.reserved, il.layby, il.available
  from inventory_levels il join child_skus cs on cs.id = il.child_sku_id
 where cs.id = '<SKU>';
```

---

## Sign-off checklist

| # | Workflow | Steps (in the app) | Expected | ✅ |
|---|----------|--------------------|----------|----|
| 1 | **Create reserves stock** | Orders → New; pick the SKU, qty **3**; Save | `available` **−3**, `reserved` **+3**, `on_hand` unchanged; order `status='created'`; one `inventory_ledger` row `reason='order_reserve'` (−3 reserved) | ☐ |
| 2 | **Cancel releases stock** | Open that order → Cancel | `reserved` back **−3**, `available` restored; `status='cancelled'`, `cancelled_at` set; ledger `reason='order_release'` | ☐ |
| 3 | **Full fulfil consumes stock** | New order qty **2** → Picking → Packing → Ship → Fulfil | Through the flow `status` goes created→picking→packed→fulfilled; on **fulfil** `on_hand` **−2** and `reserved` **−2** (available unchanged from reserved point); ledger `reason='order_consume'`; `fulfilled_at` set | ☐ |
| 4 | **Combine: box/label once, consumables summed** | Two orders, same customer + ship-to, minutes apart → the 2nd should surface as *combinable* → Combine → pack the group (1 box, 1 label; jars/bags for both) | Both orders share one `group_id`; **one** box + **one** label charged for the group; jars/bags = sum of both; each order keeps its own number/status and records what it combined with | ☐ |
| 5 | **Hold keeps stock reserved** | Put an active order on hold | `on_hold=true`; stock stays **reserved** (not released); order excluded from the pick queue until un-held; status flow otherwise unchanged | ☐ |
| 6 | **Layaway removes now, pay later** | New order, type **layaway**, qty **1** → then record a part payment | On create: `on_hand` **−1** now (ledger `layaway_remove`), removed from available; `record_order_payment` adds an `order_payments` row; balance = total − payments; stock not double-counted | ☐ |
| 7 | **Post-dated sale** | New order, set **sale date** to last month; enter today | `entered_at`=today, `sale_date`=last month (both stored); Sales report with *sale-date* filter counts it last month, with *entered-date* filter counts it today | ☐ |
| 8 | **Manual adjustment is logged** | Inventory → adjust the SKU **+5** with a note | `on_hand` **+5**; one `inventory_ledger` row `reason='manual_adjustment'` with the note + actor; adjustment rejected if note blank or it would push on_hand below reserved | ☐ |
| 9 | **Inbound import is idempotent** | Deliver a store order webhook (or replay a recorded one) twice | Order imports **once**; second delivery is deduped — `reserved`/`on_hand` move only once; `store_order_imports` has a single row for that external id | ☐ |
| 10 | **Outbound push is exact; parent never syncs** | Change a mapped child's stock; watch the integration/jobs | Store admin shows the child's **exact unit count**; `store_outbound_inventory_jobs` has a `done` job **per child only** — none for a parent; parent has no `store_variant_id` | ☐ |
| 11 | **Reports reconcile** | Open Sales, Inventory, Packaging cost, Shipping cost for the test window | Sales totals match the orders entered; Inventory shows on-hand/available/reserved/layby per SKU; Packaging cost does **not** double-count the combined group's box/label; Shipping shows est vs actual with variance | ☐ |
| 12 | **Site-scoped access** | Log in as the `client` user | Sees **only** their assigned site's SKUs/orders/reports; other sites' rows are absent; cannot edit another site's data | ☐ |

---

## Cross-cutting DB assertions (run after the pass)

```sql
-- (1–3,6) Levels always equal the sum of their ledger deltas — no silent drift.
select cs.sku, il.on_hand, il.reserved, il.layby,
       g.on_hand  as ledger_on_hand, g.reserved as ledger_reserved, g.layby as ledger_layby
  from inventory_levels il
  join child_skus cs on cs.id = il.child_sku_id
  left join (
    select child_sku_id,
           sum(delta_on_hand) on_hand, sum(delta_reserved) reserved, sum(delta_layby) layby
    from inventory_ledger group by child_sku_id) g on g.child_sku_id = il.child_sku_id
 where il.on_hand <> coalesce(g.on_hand,0)
    or il.reserved <> coalesce(g.reserved,0)
    or il.layby <> coalesce(g.layby,0);
-- Expect ZERO rows. (This is exactly what reconcile_inventory() automates.)

-- (4,11) A combined group is charged one box + one label, never per order.
select g.id as group_id,
       count(distinct o.id) as orders_in_group,
       sum(pu.quantity) filter (where pt.kind = 'box')   as boxes,
       sum(pu.quantity) filter (where pt.kind = 'shipping_label') as labels
  from fulfillment_groups g
  join orders o          on o.group_id = g.id
  join packaging_usage pu on pu.group_id = g.id
  join packaging_types pt on pt.id = pu.packaging_type_id
 group by g.id having count(distinct o.id) > 1;
-- Expect boxes = 1 and labels = 1 for each multi-order group.

-- (10) Every outbound job is per child SKU and carries its live available.
select c.sku, il.on_hand - il.reserved as live_available, j.desired_available, j.status
  from store_outbound_inventory_jobs j
  join child_skus c        on c.id = j.child_sku_id
  join inventory_levels il on il.child_sku_id = c.id;
-- Expect desired_available = live_available; no row without a child_sku_id.

-- Any stuck pushes? (should be empty)
select * from store_outbound_inventory_jobs where status = 'failed';
```

---

## Go / No-Go

**Go** when all 12 boxes pass on ≥1 location, the level-vs-ledger drift query returns
**zero rows**, the combined-group query shows **1 box + 1 label** per group, and there
are no `failed` outbound jobs after a full run.

**No-Go:** any stock number that doesn't move as Expected, a double-counted import, a
parent that produced an outbound job, or a client who can see another site. Note it
under Issues and fix before sign-off. Each migration is reversible
(`supabase/rollback/*.down.sql`, verified by the round-trip test), so backing out is safe.

---

## Sign-off

| Location | Tester(s) | Date | Result (Go / No-Go) |
|----------|-----------|------|---------------------|
|          |           |      |                     |
|          |           |      |                     |

## Issues found

-
