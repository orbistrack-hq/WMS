-- ============================================================================
-- WMS — Migration 0016: let child-SKU creation populate its inventory level
--
-- Migration 0003 locked inventory_levels (revoked INSERT/UPDATE/DELETE from the
-- app roles) so stock can only change through the guarded functions. But the
-- create_inventory_level() trigger — which inserts the one zero-quantity level
-- row when a child SKU is created — runs as the INSERTING user, not with owner
-- rights. So creating a child SKU as an authenticated user (Catalog "Add SKU",
-- or the Shopify product sync) failed with "permission denied for table
-- inventory_levels", and every variant was skipped.
--
-- Fix: promote the trigger to SECURITY DEFINER with a pinned search_path (it
-- only ever inserts the seed row for the new SKU). Direct writes to
-- inventory_levels stay revoked for everyone else — the lock is intact.
-- ============================================================================

begin;

alter function public.create_inventory_level()
  security definer
  set search_path = '';

commit;
