-- Rollback for migration 0093 (outbound inventory reconcile).
-- Drops the reconcile RPC only; the job queue, trigger, claim/complete and
-- reaper from 0026/0056/0060 are untouched. After this the app's calls to
-- reconcile_outbound_inventory_for_site will error, so deploy the matching app
-- revert alongside it.

begin;

drop function if exists public.reconcile_outbound_inventory_for_site(uuid);

commit;
