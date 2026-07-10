-- ============================================================================
-- Rollback 0059 — restore the original (0056) outbound reaper.
--
-- Reinstates the plain bulk `UPDATE ... SET status='pending'` reaper. NOTE: this
-- reintroduces the 23505 collision when a stale 'processing' job shares a SKU
-- with a 'pending' job — that is the bug 0059 fixed. Reverse only if you must.
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

commit;
