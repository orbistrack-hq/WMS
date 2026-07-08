-- ============================================================================
-- Rollback 0042: drop the packing-queue index. Safe to re-run.
-- ============================================================================
begin;

drop index if exists public.fulfillment_groups_status_window_idx;

commit;
