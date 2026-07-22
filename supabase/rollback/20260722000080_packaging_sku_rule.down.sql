-- ============================================================================
-- Rollback 0080: remove the per-child-SKU packaging override.
-- Drops the table (and with it the seeded free-eighth overrides + its RLS
-- policies and triggers). No other object depends on it, so this is clean.
-- ============================================================================

begin;

drop table if exists public.packaging_sku_rule;

commit;
