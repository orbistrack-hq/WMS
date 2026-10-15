-- Rollback for migration 0115: drop revive_failed_outbound_inventory_jobs.
-- Deploy the app without the call in app/api/store-sync/outbound/route.ts
-- first, or the scheduled drain reports a reviveError (it still drains).
-- Rows already revived or marked 'done' stay that way; that is harmless.

begin;

drop function if exists public.revive_failed_outbound_inventory_jobs(interval);

commit;
