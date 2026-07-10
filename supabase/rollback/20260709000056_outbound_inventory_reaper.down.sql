-- Rollback for migration 0056 (outbound inventory job reaper).
begin;

drop function if exists public.reap_stuck_outbound_inventory_jobs(interval);

commit;
