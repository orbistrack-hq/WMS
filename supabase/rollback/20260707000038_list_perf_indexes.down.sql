-- ============================================================================
-- Rollback 0038: drop the list-screen sort/pagination indexes.
-- Safe to re-run (IF EXISTS). Dropped in reverse creation order.
-- ============================================================================
begin;

drop index if exists public.parent_inventory_ledger_reason_created_idx;
drop index if exists public.allocations_created_at_idx;
drop index if exists public.products_name_idx;
drop index if exists public.orders_site_entered_at_idx;
drop index if exists public.orders_sale_date_idx;
drop index if exists public.orders_entered_at_idx;

commit;
