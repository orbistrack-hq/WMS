-- ============================================================================
-- Rollback 0066 — drop force_fulfill_order and the backorder_report view.
-- Both are net-new, standalone objects with no prior version to restore and
-- nothing else references them, so this reverses cleanly.
-- ============================================================================

begin;

drop view if exists public.backorder_report;
drop function if exists public.force_fulfill_order(uuid, text, timestamptz);

commit;
