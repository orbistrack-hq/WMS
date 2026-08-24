-- Diagnostic only — run these one at a time in the SQL editor. None of them
-- execute the slow query itself (EXPLAIN without ANALYZE only plans it), so
-- none of these should time out even though the report function does.

-- 1. Real row counts. If any of these are far bigger than "a site under 90
--    days old" suggests, that's likely dev/seed/test data inflating the
--    tables the function has to scan (same pattern as the audit_log finding).
select 'orders' as t, count(*) from public.orders
union all select 'order_line_items', count(*) from public.order_line_items
union all select 'packaging_usage', count(*) from public.packaging_usage
union all select 'shipments', count(*) from public.shipments
union all select 'fulfillment_groups', count(*) from public.fulfillment_groups;

-- 2. How many orders actually fall in a 30-day fulfilled window — this is
--    what target_groups/order_rev should be bounded to.
select count(*) as fulfilled_last_30d
from public.orders
where status = 'fulfilled'
  and sale_date >= current_date - 30
  and sale_date <= current_date;

-- 3. The query PLAN for the function call (does not execute the aggregation,
--    just shows what Postgres intends to do — safe even though the real call
--    times out). Look for "Seq Scan" on packaging_usage, shipments, or
--    orders in the output — that's the smoking gun if present.
explain
select * from public.landed_margin_report(
  (current_date - 30)::date,
  current_date::date
);

-- 4. Confirm the new index actually exists and is a real btree on sale_date
--    (in case an earlier attempt created a namesake index with a different
--    definition, which "create index if not exists" would have silently
--    left in place instead of replacing).
select indexname, indexdef
from pg_indexes
where schemaname = 'public' and indexname = 'orders_sale_date_idx';

-- 5. When statistics were last refreshed for the tables involved — a stale
--    ANALYZE right after adding a new index can make the planner misjudge
--    selectivity and pick a bad plan.
select relname, last_analyze, last_autoanalyze
from pg_stat_user_tables
where relname in ('orders', 'order_line_items', 'packaging_usage', 'shipments');
