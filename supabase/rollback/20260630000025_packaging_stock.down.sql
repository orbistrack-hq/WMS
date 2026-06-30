-- ============================================================================
-- WMS — Rollback 0025: per-site packaging stock
-- Reverses 20260630000025_packaging_stock.sql. Drops the stock tables, their
-- ledger, the consumption trigger, the sanctioned writer functions, and the
-- valuation view. packaging_types itself is left untouched.
-- ============================================================================

begin;

drop view if exists public.packaging_stock_report;

drop trigger if exists packaging_usage_stock on public.packaging_usage;
drop function if exists public.tg_packaging_usage_stock();

drop function if exists public.set_packaging_reorder_point(uuid,uuid,integer);
drop function if exists public.adjust_packaging(uuid,uuid,integer,text);
drop function if exists public.receive_packaging(uuid,uuid,integer,text);
drop function if exists public._pkg_write(uuid,uuid,integer,text,text,uuid,text);
drop function if exists public._pkg_lock(uuid,uuid);

-- Audit/updated_at triggers drop with the tables.
drop table if exists public.packaging_ledger;
drop table if exists public.packaging_levels;

commit;
