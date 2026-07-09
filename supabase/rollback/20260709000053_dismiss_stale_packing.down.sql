-- ============================================================================
-- Rollback for migration 0053: remove dismiss support from fulfillment groups.
-- (Dismissed groups reappear on the packing queue once the columns are dropped.)
-- ============================================================================

begin;

drop function if exists public.dismiss_stale_fulfillment_groups(timestamptz);
drop function if exists public.undismiss_fulfillment_group(uuid);
drop function if exists public.dismiss_fulfillment_group(uuid);

drop index if exists public.fulfillment_groups_queue_idx;

alter table public.fulfillment_groups drop column if exists dismissed_by;
alter table public.fulfillment_groups drop column if exists dismissed_at;

commit;
