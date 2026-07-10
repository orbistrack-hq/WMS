-- ============================================================================
-- WMS — Migration 0060: defer_outbound_inventory_job (circuit-breaker support)
--
-- The outbound drain (lib/store-sync/outbound.ts) gains a per-run circuit
-- breaker: after a few consecutive failures on one store it stops pushing that
-- store's remaining jobs for the rest of the run and parks them for a cooldown,
-- so a slow/erroring store can't burn the drain's time budget or starve the
-- healthy stores. Parking must NOT look like a failure — it must not increment
-- attempts (which would march the job toward the give-up cap during an outage it
-- had no control over) and must not record an error.
--
-- This adds the primitive the drain uses to park a claimed job: flip it back to
-- 'pending' with next_attempt_at = the cooldown end, leaving attempts and
-- last_error untouched. next_attempt_at in the future keeps the claim (which
-- only takes due 'pending' rows) from re-serving it until the cooldown elapses.
-- SECURITY DEFINER + service-role only, matching claim/complete/reap (0026/0056).
--
-- Reverse with rollback/20260710000060_outbound_defer_job.down.sql.
-- ============================================================================

begin;

create or replace function public.defer_outbound_inventory_job(
  p_job_id uuid,
  p_until  timestamptz
) returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.store_outbound_inventory_jobs
     set status          = 'pending',
         next_attempt_at  = greatest(p_until, now()),
         updated_at       = now()
   where id = p_job_id
     and status = 'processing';
end;
$$;

comment on function public.defer_outbound_inventory_job(uuid, timestamptz) is
  'Park a claimed outbound job for a cooldown: back to pending at next_attempt_at=p_until, attempts and last_error untouched (NOT a failure). Used by the drain''s per-store circuit breaker so a slow/down store cannot burn the time budget or march its jobs toward give-up. Service-role only.';

revoke execute on function public.defer_outbound_inventory_job(uuid, timestamptz) from public;
do $$
declare r text;
begin
  foreach r in array array['authenticated','anon','app_user'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format(
        'revoke execute on function public.defer_outbound_inventory_job(uuid, timestamptz) from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.defer_outbound_inventory_job(uuid, timestamptz) to service_role;
  end if;
end $$;

commit;
