-- ============================================================================
-- WMS — Migration 0059: make the outbound reaper resilient to pending twins
--
-- BUG. reap_stuck_outbound_inventory_jobs (0056) recovers stranded jobs with a
-- bulk `UPDATE ... SET status='pending'` over every stale 'processing' row. But
-- the enqueue trigger's one-pending guard (store_outbound_jobs_one_pending, a
-- UNIQUE index on child_sku_id WHERE status='pending') only dedupes PENDING
-- rows — so a job stuck in 'processing' can coexist with a newer 'pending' job
-- for the same SKU. When the reaper tries to flip that stale 'processing' row to
-- 'pending', it collides with the pending twin and the whole statement throws
-- 23505. The scheduled drain / server action swallowed the RPC error, so NOTHING
-- got reaped and 'processing' zombies piled up for hours (observed: 300+ rows,
-- attempts=0, age >17h), starving the queue.
--
-- FIX. A stale 'processing' job is superseded when its SKU already has a 'pending'
-- job (that pending row carries the newer target). And two stale 'processing'
-- rows for one SKU are redundant — only the newest should survive. So:
--   1. DELETE stale 'processing' rows that have a 'pending' twin, or that aren't
--      the newest 'processing' row for their SKU.
--   2. Flip the survivors (newest per SKU, no pending twin) to 'pending' — now
--      guaranteed at most one per SKU, so no unique collision.
-- Returns the total recovered (deleted + reset). Absolute-SET pushes mean
-- dropping a superseded job never loses stock: the surviving/pending job pushes
-- the current available.
--
-- Signature, security, and grants unchanged. Reverse with the matching down.
-- ============================================================================

begin;

create or replace function public.reap_stuck_outbound_inventory_jobs(
  p_stale_after interval default interval '5 minutes'
) returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_deleted integer;
  v_reset   integer;
begin
  -- 1. Drop superseded / duplicate stale 'processing' rows.
  with ranked as (
    select id, child_sku_id,
           row_number() over (
             partition by child_sku_id order by updated_at desc, id) as rn
      from public.store_outbound_inventory_jobs
     where status = 'processing'
       and updated_at < now() - p_stale_after
  ),
  del as (
    delete from public.store_outbound_inventory_jobs p
     using ranked r
     where p.id = r.id
       and (
         r.rn > 1
         or exists (
           select 1 from public.store_outbound_inventory_jobs q
            where q.child_sku_id = p.child_sku_id and q.status = 'pending')
       )
    returning p.id
  )
  select count(*) into v_deleted from del;

  -- 2. Reset the survivors — newest per SKU, no pending twin — to 'pending'.
  --    At most one row per SKU reaches here, so the one-pending guard holds.
  with reset as (
    update public.store_outbound_inventory_jobs p
       set status = 'pending', next_attempt_at = now(), updated_at = now()
     where p.status = 'processing'
       and p.updated_at < now() - p_stale_after
       and not exists (
         select 1 from public.store_outbound_inventory_jobs q
          where q.child_sku_id = p.child_sku_id and q.status = 'pending')
    returning 1
  )
  select count(*) into v_reset from reset;

  return coalesce(v_deleted, 0) + coalesce(v_reset, 0);
end;
$$;

comment on function public.reap_stuck_outbound_inventory_jobs(interval) is
  'Recover outbound jobs stranded in ''processing'' past p_stale_after: delete rows superseded by a ''pending'' twin or an newer same-SKU processing row, reset the survivors to ''pending''. Resilient to store_outbound_jobs_one_pending (migration 0059 fixed the 0056 bulk-update that collided with pending twins). Service-role only.';

commit;
