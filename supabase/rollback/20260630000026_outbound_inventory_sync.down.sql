-- ============================================================================
-- WMS — Rollback 0026: outbound inventory sync
-- Reverses 20260630000026_outbound_inventory_sync.sql.
-- ============================================================================

begin;

drop view if exists public.store_outbound_sync_status;

drop trigger if exists inventory_ledger_outbound on public.inventory_ledger;
drop function if exists public.tg_enqueue_outbound_inventory();
drop function if exists public.claim_outbound_inventory_jobs(integer);
drop function if exists public.complete_outbound_inventory_job(uuid,boolean,text,boolean,integer);

drop table if exists public.store_outbound_inventory_jobs;

alter table public.store_connections
  drop column if exists sync_inventory_outbound,
  drop column if exists inventory_location_id;

alter table public.child_skus
  drop column if exists store_parent_id,
  drop column if exists store_inventory_item_id;

commit;
