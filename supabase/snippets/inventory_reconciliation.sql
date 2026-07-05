-- =============================================================================
-- DRAFT — Inventory reconciliation (GO-LIVE §5)
-- =============================================================================
-- Periodic drift detector. Two invariants a healthy warehouse must never break:
--
--   1. LEVELS == LEDGER.  inventory_levels is a running cache; inventory_ledger
--      is the append-only truth. For every child SKU the cached on_hand /
--      reserved / layby must equal the sum of its ledger deltas. Any gap means a
--      level was mutated outside the ledger (a bug) — the durable signal of
--      silent desync.
--
--   2. PARENT GRAMS vs CHILD UNITS.  Weight-variant children are carved out of
--      parent bulk. The grams still committed to children (units on hand+reserved
--      x grams_per_unit) should track the parent's allocated_grams counter.
--
-- This is a DRAFT snippet, NOT a migration: review it, run it against a Supabase
-- branch, confirm the parent/child identity below matches the allocation model,
-- then promote it to supabase/migrations/ and wire the route + schedule.
--
-- Safe to run repeatedly; read-only (only CREATE VIEW / FUNCTION).
-- =============================================================================

-- 1) Level-vs-ledger drift, one row per child SKU. drift_* = cached - ledger sum;
--    all three are 0 in a healthy system.
create or replace view public.inventory_level_reconciliation as
select
  l.child_sku_id,
  cs.site_id,
  cs.sku,
  l.on_hand,
  coalesce(g.sum_on_hand, 0)   as ledger_on_hand,
  l.reserved,
  coalesce(g.sum_reserved, 0)  as ledger_reserved,
  l.layby,
  coalesce(g.sum_layby, 0)     as ledger_layby,
  l.on_hand  - coalesce(g.sum_on_hand, 0)  as drift_on_hand,
  l.reserved - coalesce(g.sum_reserved, 0) as drift_reserved,
  l.layby    - coalesce(g.sum_layby, 0)    as drift_layby
from public.inventory_levels l
join public.child_skus cs on cs.id = l.child_sku_id
left join (
  select child_sku_id,
         sum(delta_on_hand)  as sum_on_hand,
         sum(delta_reserved) as sum_reserved,
         sum(delta_layby)    as sum_layby
  from public.inventory_ledger
  group by child_sku_id
) g on g.child_sku_id = l.child_sku_id;

-- 2) Parent-grams vs committed child-grams, one row per product+site.
--    NOTE: confirm this identity against the allocation model before trusting
--    it as a hard invariant — layby handling in particular may need a term here.
create or replace view public.parent_child_reconciliation as
select
  pi.product_id,
  pi.site_id,
  pi.on_hand_grams,
  pi.allocated_grams,
  coalesce(c.child_committed_grams, 0) as child_committed_grams,
  pi.allocated_grams - coalesce(c.child_committed_grams, 0) as drift_grams
from public.parent_inventory pi
left join (
  select cs.product_id, cs.site_id,
         sum((l.on_hand + l.reserved) * cs.grams_per_unit) as child_committed_grams
  from public.child_skus cs
  join public.inventory_levels l on l.child_sku_id = cs.id
  where cs.grams_per_unit is not null
  group by cs.product_id, cs.site_id
) c on c.product_id = pi.product_id and c.site_id = pi.site_id;

-- 3) Alert surface: return ONLY drifting rows, so a scheduled job can page when
--    the result is non-empty. Sealed to service_role (called by the drain/cron).
create or replace function public.reconcile_inventory()
returns table (
  kind          text,
  child_sku_id  uuid,
  product_id    uuid,
  site_id       uuid,
  detail        jsonb
)
language sql
security definer
set search_path = public
as $$
  select 'level_drift'::text, r.child_sku_id, null::uuid, r.site_id,
         jsonb_build_object(
           'sku', r.sku,
           'drift_on_hand', r.drift_on_hand,
           'drift_reserved', r.drift_reserved,
           'drift_layby', r.drift_layby)
  from public.inventory_level_reconciliation r
  where r.drift_on_hand <> 0 or r.drift_reserved <> 0 or r.drift_layby <> 0
  union all
  select 'parent_child_drift'::text, null::uuid, p.product_id, p.site_id,
         jsonb_build_object(
           'allocated_grams', p.allocated_grams,
           'child_committed_grams', p.child_committed_grams,
           'drift_grams', p.drift_grams)
  from public.parent_child_reconciliation p
  where p.drift_grams <> 0;
$$;

revoke all on function public.reconcile_inventory() from anon, authenticated;
grant execute on function public.reconcile_inventory() to service_role;
