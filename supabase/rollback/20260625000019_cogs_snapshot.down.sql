-- WMS — Migration 0019 (cogs_snapshot): DOWN
-- 0019 added: order_line_items.unit_cost_snapshot, the cogs_report view, and a
-- fulfillment-time cost snapshot inside apply_order_fulfillment.
-- In the reverse chain the function body is already reverted before this runs
-- (rollback 0024 restores the pre-snapshot apply_order_fulfillment), so here we
-- only drop the view and the column. Drop the view first — it reads the column.
begin;
drop view if exists public.cogs_report;
alter table public.order_line_items drop column if exists unit_cost_snapshot;
commit;
