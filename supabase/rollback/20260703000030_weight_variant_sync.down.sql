-- ============================================================================
-- Rollback for migration 0030 — forward weight-variant sync.
-- Drops the writer. Child SKUs it created keep their grams_per_unit (managed by
-- migration 0028's columns); this only removes the sync entry point.
-- ============================================================================

begin;

drop function if exists public.upsert_store_weight_variant(
  uuid, text, text, numeric, text, numeric, numeric, integer, text);

commit;
