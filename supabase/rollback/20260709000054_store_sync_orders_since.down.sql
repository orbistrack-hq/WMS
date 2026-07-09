-- ============================================================================
-- Rollback 0048: drop the per-connection order-sync cutoff. Safe to re-run.
-- ============================================================================
begin;

alter table public.store_connections
  drop column if exists sync_orders_since;

commit;
