-- ============================================================================
-- WMS — Rollback 0083: remove the sku_commitments view
--
-- Drops the read-only view and the child_sku lookup index it was added with.
-- The view writes nothing, so there is no data to unwind — after reversing,
-- the inventory item page's "Committed stock" card degrades to a notice that
-- the migration has not been applied (the app checks for 42P01 and falls back).
--
-- Round-trip safe: creates nothing, and drops only objects 0083 created.
-- ============================================================================

begin;

drop view if exists public.sku_commitments;
drop index if exists public.order_line_items_child_sku_idx;

commit;
