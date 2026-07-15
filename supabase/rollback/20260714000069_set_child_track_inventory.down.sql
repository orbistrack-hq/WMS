-- ============================================================================
-- Rollback for migration 0069 — drop the manual track_inventory toggle RPC.
-- ============================================================================

begin;

drop function if exists public.set_child_track_inventory(uuid, boolean);

commit;
