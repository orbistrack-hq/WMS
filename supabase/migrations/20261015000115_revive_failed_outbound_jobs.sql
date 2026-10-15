-- ============================================================================
-- WMS — Migration 0115: revive 'failed' outbound inventory jobs automatically
--
-- THE PROBLEM
-- complete_outbound_inventory_job (0026) marks a job 'failed' once it burns its
-- 8th attempt, and 'failed' is terminal: nothing in the drain ever looks at it
-- again. But 'failed' only ever means TRANSIENT trouble (timeout, 5xx, missing
-- credentials) — a bad mapping goes to 'skipped' instead. So a store that was
-- slow for a few hours leaves a pile of 'failed' rows that:
--   * never retry, so any SKU whose last push really didn't land stays stale on
--     the storefront until some unrelated movement touches it again, and
--   * never clear from store_outbound_sync_status, so the integrations page's
--     "N failed" badge only ever grows — even after a later push succeeded, and
--     even after "Re-push all stock" (reconcile adds a fresh pending row but
--     leaves the old failed rows behind).
-- Observed on budclubshop.com 2026-10-13/14: 56 failed rows over 33 SKUs, all
-- "aborted due to timeout"; 31 of the 33 had in fact landed on the store.
--
-- THE FIX
-- revive_failed_outbound_inventory_jobs, called by the scheduled drain before it
-- claims work. For every 'failed' row:
--   * superseded — the SKU has a newer job of any status, or a pending /
--     processing one that will push the live available anyway — becomes 'done'
--     with its last_error kept for history;
--   * otherwise the NEWEST failed row per SKU, once it has rested p_older_than,
--     goes back to 'pending' with attempts reset (older failed rows for the same
--     SKU become 'done'), provided the site still has an active outbound
--     connection and the SKU is still mapped.
-- Safe to repeat: pushes are absolute SETs (0026), so re-pushing a SKU that did
-- land is a no-op on the store. A store that stays down costs one round of
-- attempts per SKU per p_older_than, and the drain's circuit breaker parks those
-- without burning attempts.
--
-- Reverse with rollback/20261015000115_revive_failed_outbound_jobs.down.sql.
-- ============================================================================

begin;

create or replace function public.revive_failed_outbound_inventory_jobs(
  p_older_than interval default interval '1 hour'
) returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_superseded integer;
  v_revived    integer := 0;
  r            record;
begin
  -- 1. Retire failed rows that a later or live job already covers.
  with sup as (
    update public.store_outbound_inventory_jobs f
       set status = 'done', updated_at = now()
     where f.status = 'failed'
       and exists (
         select 1 from public.store_outbound_inventory_jobs o
          where o.child_sku_id = f.child_sku_id
            and o.id <> f.id
            and (o.status in ('pending', 'processing')
                 or o.created_at > f.created_at))
    returning 1
  )
  select count(*) into v_superseded from sup;

  -- 2. What is left is at most one failed row per SKU, with nothing newer.
  --    Requeue it once it has rested, if the store can still take the push.
  for r in
    select f.id
      from public.store_outbound_inventory_jobs f
      join public.child_skus cs on cs.id = f.child_sku_id
     where f.status = 'failed'
       and coalesce(f.processed_at, f.updated_at) < now() - p_older_than
       and cs.store_variant_id is not null
       and exists (
         select 1 from public.store_connections c
          where c.site_id = f.site_id and c.is_active and c.sync_inventory_outbound)
  loop
    begin
      update public.store_outbound_inventory_jobs
         set status = 'pending', attempts = 0, next_attempt_at = now(),
             processed_at = null, updated_at = now()
       where id = r.id and status = 'failed';
      v_revived := v_revived + 1;
    exception when unique_violation then
      -- A ledger movement enqueued a pending job for this SKU since step 1;
      -- that job pushes the live available, so this one is superseded.
      update public.store_outbound_inventory_jobs
         set status = 'done', updated_at = now()
       where id = r.id;
      v_superseded := v_superseded + 1;
    end;
  end loop;

  return coalesce(v_superseded, 0) + v_revived;
end;
$$;

comment on function public.revive_failed_outbound_inventory_jobs(interval) is
  'Clear terminal ''failed'' outbound jobs: mark rows superseded by a newer or live job ''done'', and requeue the newest failed row per SKU as ''pending'' (attempts reset) once it has rested p_older_than. Called by the scheduled drain. Service-role only.';

revoke execute on function public.revive_failed_outbound_inventory_jobs(interval) from public;
do $$
declare r text;
begin
  foreach r in array array['authenticated','anon','app_user'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format(
        'revoke execute on function public.revive_failed_outbound_inventory_jobs(interval) from %I',
        r
      );
    end if;
  end loop;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.revive_failed_outbound_inventory_jobs(interval) to service_role;
  end if;
end $$;

commit;
