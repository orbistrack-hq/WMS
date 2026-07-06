-- WMS — Migration 0021 (merge_duplicate_products): DOWN
-- Reverse the schema objects this migration added. NOTE: the one-time
-- merge_products_by_sku() run in the UP mutated data (moved child_skus onto a
-- surviving parent, deactivated emptied parents); that data change is recorded
-- in product_merge_log but is NOT undone here — dropping the objects only
-- reverses the schema. On a freshly-migrated DB with no duplicates the UP run is
-- a no-op, so a round-trip leaves no residue.
begin;
drop function if exists public.merge_products_by_sku();
drop view if exists public.duplicate_products_report;
drop table if exists public.product_merge_log;
commit;
