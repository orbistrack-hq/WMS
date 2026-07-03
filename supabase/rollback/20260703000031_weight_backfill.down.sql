-- ============================================================================
-- Rollback for migration 0031 — weight-variant backfill.
-- Drops the consolidation function. Any re-parenting it already applied is a
-- normal catalog state and is not reverted here.
-- ============================================================================

begin;

drop function if exists public.consolidate_weight_group(text, jsonb, boolean);

commit;
