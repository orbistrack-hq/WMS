-- Outbound reliability: migration 0059 (reaper tolerates a pending twin) and
-- 0060 (defer parks a job without burning an attempt). Direct row inserts model
-- the states the drain produces. Uses the seeded SKU at MAIN.
begin;
select plan(8);
\set SKU  '''a0000000-0000-0000-0000-000000000001'''
\set MAIN '''11111111-1111-1111-1111-111111111111'''

-- Map the SKU and connect an outbound-enabled store (rows must reference a real
-- site). adjust_stock runs BEFORE the mapping so it doesn't enqueue anything.
select adjust_stock(:SKU, -200, 'reset seed opening stock');
update child_skus
   set store_variant_id = 'shopvar-1', store_inventory_item_id = 'inv-1'
 where id = :SKU;
insert into store_connections
  (source, site_id, channel, is_active, sync_inventory_outbound, inventory_location_id)
values ('test.myshopify.com', :MAIN, 'shopify', true, true, 'loc-1');

-- ---- 0059: a stale 'processing' zombie WITH a 'pending' twin -----------------
-- Before 0059 the reaper's bulk UPDATE collided with store_outbound_jobs_one_pending
-- and threw 23505, reaping nothing.
insert into store_outbound_inventory_jobs
  (child_sku_id, site_id, desired_available, status, updated_at, next_attempt_at)
values (:SKU, :MAIN, 10, 'processing', now() - interval '1 hour', now() - interval '1 hour');
insert into store_outbound_inventory_jobs
  (child_sku_id, site_id, desired_available, status, updated_at, next_attempt_at)
values (:SKU, :MAIN, 20, 'pending', now(), now());

select lives_ok(
  $$ select public.reap_stuck_outbound_inventory_jobs(interval '5 minutes') $$,
  'reaper does not throw when a stale processing job has a pending twin');
select is(
  (select count(*)::int from store_outbound_inventory_jobs
     where child_sku_id = :SKU and status = 'processing'),
  0, 'the superseded processing zombie is removed');
select is(
  (select count(*)::int from store_outbound_inventory_jobs
     where child_sku_id = :SKU and status = 'pending'),
  1, 'the pending twin survives (one-pending-per-SKU held)');

delete from store_outbound_inventory_jobs where child_sku_id = :SKU;

-- ---- 0059: a lone stale 'processing' job (no twin) resets to pending ---------
insert into store_outbound_inventory_jobs
  (child_sku_id, site_id, desired_available, status, updated_at, next_attempt_at)
values (:SKU, :MAIN, 15, 'processing', now() - interval '1 hour', now() - interval '1 hour');
select is(
  public.reap_stuck_outbound_inventory_jobs(interval '5 minutes'),
  1, 'reaper recovers exactly one lone stale processing job');
select is(
  (select status from store_outbound_inventory_jobs where child_sku_id = :SKU),
  'pending', 'the lone stale processing job is reset to pending');

delete from store_outbound_inventory_jobs where child_sku_id = :SKU;

-- ---- 0060: defer parks a processing job without penalty ----------------------
insert into store_outbound_inventory_jobs
  (id, child_sku_id, site_id, desired_available, status, attempts, updated_at, next_attempt_at)
values ('b0000000-0000-0000-0000-0000000000d1', :SKU, :MAIN, 7, 'processing', 2, now(), now());
select public.defer_outbound_inventory_job(
  'b0000000-0000-0000-0000-0000000000d1', now() + interval '10 minutes');
select is(
  (select status from store_outbound_inventory_jobs
     where id = 'b0000000-0000-0000-0000-0000000000d1'),
  'pending', 'defer returns the job to pending');
select is(
  (select attempts from store_outbound_inventory_jobs
     where id = 'b0000000-0000-0000-0000-0000000000d1'),
  2, 'defer does NOT increment attempts (parking is not a failure)');
select ok(
  (select next_attempt_at > now() + interval '5 minutes'
     from store_outbound_inventory_jobs
    where id = 'b0000000-0000-0000-0000-0000000000d1'),
  'defer parks the job at the cooldown (future next_attempt_at)');

select * from finish();
rollback;
