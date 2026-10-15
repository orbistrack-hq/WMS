-- Revive failed outbound jobs: migration 0115. 'failed' was terminal, so a slow
-- store left SKUs that never retried and a failed badge that never cleared.
-- Uses the seeded SKU at MAIN.
begin;
select plan(7);
\set SKU  '''a0000000-0000-0000-0000-000000000001'''
\set MAIN '''11111111-1111-1111-1111-111111111111'''

update child_skus set store_variant_id = 'wc-var-1', store_parent_id = 'wc-parent-1'
 where id = :SKU;
insert into store_connections (source, site_id, channel, is_active, sync_inventory_outbound)
values ('https://example.test', :MAIN, 'woocommerce', true, true);
delete from store_outbound_inventory_jobs where child_sku_id = :SKU;

-- Two failed rows for one SKU, both long past the rest period.
insert into store_outbound_inventory_jobs
  (child_sku_id, site_id, desired_available, status, attempts, last_error,
   created_at, processed_at)
values
  (:SKU, :MAIN, 5, 'failed', 8, 'timeout', now() - interval '5 hours', now() - interval '4 hours'),
  (:SKU, :MAIN, 6, 'failed', 8, 'timeout', now() - interval '3 hours', now() - interval '2 hours');

select is(public.revive_failed_outbound_inventory_jobs(), 2,
  'reports one superseded row and one revived row');
select is(
  (select count(*)::int from store_outbound_inventory_jobs
     where child_sku_id = :SKU and status = 'failed'),
  0, 'no failed rows are left for the SKU');
select is(
  (select attempts from store_outbound_inventory_jobs
     where child_sku_id = :SKU and status = 'pending'),
  0, 'the newest failed row is pending again with attempts reset');
select is(
  (select last_error from store_outbound_inventory_jobs
     where child_sku_id = :SKU and status = 'done'),
  'timeout', 'the older row is retired as done and keeps its error');

-- A failed row newer than the rest period waits.
update store_outbound_inventory_jobs
   set status = 'failed', attempts = 8, processed_at = now() - interval '10 minutes'
 where child_sku_id = :SKU and status = 'pending';
select is(public.revive_failed_outbound_inventory_jobs(), 0,
  'a recently failed job is left alone until it has rested');

-- A failed row with a live pending twin is superseded, not revived.
insert into store_outbound_inventory_jobs (child_sku_id, site_id, desired_available)
values (:SKU, :MAIN, 7);
select is(public.revive_failed_outbound_inventory_jobs(), 1,
  'a failed row with a pending twin is superseded');

-- A store with outbound turned off gets nothing requeued.
delete from store_outbound_inventory_jobs where child_sku_id = :SKU;
insert into store_outbound_inventory_jobs
  (child_sku_id, site_id, desired_available, status, attempts, processed_at)
values (:SKU, :MAIN, 5, 'failed', 8, now() - interval '2 hours');
update store_connections set sync_inventory_outbound = false where site_id = :MAIN;
select is(public.revive_failed_outbound_inventory_jobs(), 0,
  'nothing is revived while the store has outbound off');

select * from finish();
rollback;
