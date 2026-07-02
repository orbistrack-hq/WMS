-- Outbound inventory sync: enqueue trigger, loop suppression, coalescing,
-- live-available claim, backoff, failure cap, and supersede. DB-side only
-- (the HTTP push to the store is exercised separately). Uses seeded SKUs at MAIN.
begin;
select plan(14);
\set SKU  '''a0000000-0000-0000-0000-000000000001'''
\set SKU2 '''a0000000-0000-0000-0000-000000000002'''
\set MAIN '''11111111-1111-1111-1111-111111111111'''

-- Neutralize the seed's opening stock (200) on this SKU so the assertions below
-- reason from a clean zero base. Done BEFORE the store-variant mapping so this
-- reset itself does not enqueue an outbound job.
select adjust_stock(:SKU, -200, 'reset seed opening stock for a deterministic outbound test');

-- Map SKU to a store variant and connect an outbound-enabled Shopify store.
update child_skus
   set store_variant_id = 'shopvar-1', store_inventory_item_id = 'inv-1'
 where id = :SKU;
insert into store_connections
  (source, site_id, channel, is_active, sync_inventory_outbound, inventory_location_id)
values ('test.myshopify.com', :MAIN, 'shopify', true, true, 'loc-1');

-- 1. a stock movement enqueues exactly one pending outbound job
select receive_stock(:SKU, 100);
select is(
  (select count(*)::int from store_outbound_inventory_jobs where child_sku_id=:SKU and status='pending'),
  1, 'a receipt enqueues one pending outbound job');

-- 2. a second movement coalesces into the same pending job
select receive_stock(:SKU, 20);
select is(
  (select count(*)::int from store_outbound_inventory_jobs where child_sku_id=:SKU and status='pending'),
  1, 'a second movement coalesces into the same pending job');

-- 3. claim returns LIVE available (on_hand 120 - reserved 0) and marks processing
create temp table _c1 on commit drop as select * from claim_outbound_inventory_jobs(10);
select is((select desired_available from _c1 where child_sku_id=:SKU), 120,
  'claim returns the live available (120), not a stale snapshot');
select is(
  (select count(*)::int from store_outbound_inventory_jobs where child_sku_id=:SKU and status='pending'),
  0, 'claiming moves the job out of pending');

-- 4. completing OK marks it done
select complete_outbound_inventory_job((select job_id from _c1 where child_sku_id=:SKU), true);
select is(
  (select status from store_outbound_inventory_jobs where id=(select job_id from _c1 where child_sku_id=:SKU)),
  'done', 'a successful push marks the job done');

-- 5. LOOP SUPPRESSION: a store-origin movement (reason shopify_sync) is not re-enqueued
select set_on_hand_to(:SKU, 50, 'shopify', null, 'from store');
select is(
  (select count(*)::int from store_outbound_inventory_jobs where child_sku_id=:SKU and status='pending'),
  0, 'shopify_sync movements are never re-enqueued (no echo loop)');

-- 6. no enqueue when the connection has outbound disabled
update store_connections set sync_inventory_outbound=false where site_id=:MAIN and channel='shopify';
select adjust_stock(:SKU, 5, 'count');
select is(
  (select count(*)::int from store_outbound_inventory_jobs where child_sku_id=:SKU and status='pending'),
  0, 'no job is enqueued while outbound is disabled');
update store_connections set sync_inventory_outbound=true where site_id=:MAIN and channel='shopify';

-- 7. an unmapped SKU (no store_variant_id) is never enqueued
select receive_stock(:SKU2, 10);
select is(
  (select count(*)::int from store_outbound_inventory_jobs where child_sku_id=:SKU2),
  0, 'an unmapped SKU is never enqueued');

-- 8. a transient failure returns the job to pending with backoff
select adjust_stock(:SKU, 1, 'change');
create temp table _c2 on commit drop as select * from claim_outbound_inventory_jobs(10);
select complete_outbound_inventory_job((select job_id from _c2 where child_sku_id=:SKU), false, 'boom');
select is(
  (select status from store_outbound_inventory_jobs where id=(select job_id from _c2 where child_sku_id=:SKU)),
  'pending', 'a transient failure returns the job to pending');
select is(
  (select attempts from store_outbound_inventory_jobs where id=(select job_id from _c2 where child_sku_id=:SKU)),
  1, 'attempts is incremented on failure');
select ok(
  (select next_attempt_at > now() from store_outbound_inventory_jobs where id=(select job_id from _c2 where child_sku_id=:SKU)),
  'failure schedules a future backoff retry');

-- 9. the attempt cap marks a job permanently failed
update store_outbound_inventory_jobs set next_attempt_at=now() where status='pending';
create temp table _c3 on commit drop as select * from claim_outbound_inventory_jobs(10);
select complete_outbound_inventory_job((select job_id from _c3 where child_sku_id=:SKU), false, 'boom2', false, 1);
select is(
  (select status from store_outbound_inventory_jobs where id=(select job_id from _c3 where child_sku_id=:SKU)),
  'failed', 'reaching the attempt cap marks the job failed');

-- 10. supersede: failing a job while a NEWER pending job exists marks the old one done
select adjust_stock(:SKU, 1, 'm1');
update store_outbound_inventory_jobs set next_attempt_at=now() where status='pending';
create temp table _c4 on commit drop as select * from claim_outbound_inventory_jobs(10);  -- claims P1 (processing)
select adjust_stock(:SKU, 1, 'm2');  -- creates P2 (pending) while P1 is processing
select complete_outbound_inventory_job((select job_id from _c4 where child_sku_id=:SKU), false, 'late');
select is(
  (select status from store_outbound_inventory_jobs where id=(select job_id from _c4 where child_sku_id=:SKU)),
  'done', 'failing a superseded job marks it done (newer pending wins)');
select is(
  (select count(*)::int from store_outbound_inventory_jobs where child_sku_id=:SKU and status='pending'),
  1, 'exactly one pending job remains after supersede');

select * from finish();
rollback;
