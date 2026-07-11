-- ============================================================================
-- Rollback 0062 — drop the orders_missing_packaging report view.
-- Read-only view; nothing else references it, so this reverses cleanly.
-- ============================================================================

begin;

drop view if exists public.orders_missing_packaging;

commit;
