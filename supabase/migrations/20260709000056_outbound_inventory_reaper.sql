-- ============================================================================
-- WMS — Migration 0056: outbound inventory job reaper
--
-- The outbound drain (lib/store-sync/outbound.ts) claims jobs by flipping them
-- to 'processing' (claim_outbound_inventory_jobs), then records a terminal
-- outcome via complete_outbound_inventory_job. If a drain run is killed BEFORE
-- it completes a claimed job — a serverless function timeout, an instance
-- recycle, or the new in-code time budget elapsing — that job is stranded in
-- 'processing' with nothing to move it. The one-pending-per-SKU unique index
-- still lets new movements enqueue fresh 'pending' rows, so the queue visibly
-- grows while stranded rows never retry.
--
-- This adds a reaper: reset 'processing' rows that have not been touched for a
-- while back to 'pending' so the next drain retries them. SECURITY DEFINER and
-- service-role only, matching claim/complete (migration 0026). Safe to call on
-- every scheduled drain: it only touches rows older than p_stale_after, so a
-- job actively being processed by a concurrent drain (updated_at ~= now) is left
-- alone.
--
-- Reverse with rollback/20260709000056_outbound_inventory_reaper.down.sql.
-- ============================================================================

begin;

create or replace function public.reap_stuck_outbound_inventory_jobs(
  p_stale_after interval default interval '5 minutes'
) returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  with reset as (
    update public.store_outbound_inventory_jobs
       set status          = 'pending',
           next_attempt_at = now(),
           updated_at      = now()
     where status = 'processing'
       and updated_at < now() - p_stale_after
    returning 1
  )
  select count(*) into v_count from reset;
  return coalesce(v_count, 0);
end;
$$;

-- Writes to the queue happen only through the SECURITY DEFINER functions; the
-- reaper is the worker's, never callable by app users.
revoke execute on function public.reap_stuck_outbound_inventory_jobs(interval) from public;
do $$
declare r text;
begin
  foreach r in array array['authenticated','anon','app_user'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format(
        'revoke execute on function public.reap_stuck_outbound_inventory_jobs(interval) from %I',
        r
      );
    end if;
  end loop;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.reap_stuck_outbound_inventory_jobs(interval) to service_role;
  end if;
end $$;

commit;
