-- Outbound reconcile: migration 0093. Covers the silent-drop the enqueue trigger
-- (0026) produces when stock moves before a store is fully wired up — the case
-- where allocating inventory to a store with no active/outbound-enabled
-- connection left NO job at all, so no amount of draining ever pushed it.
-- Uses the seeded SKU at MAIN.
begin;
select plan(9);
\set SKU  '''a0000000-0000-0000-0000-000000000001'''
\set MAIN '''11111111-1111-1111-1111-111111111111'''

-- Map the SKU, and connect a store that is active but with outbound still OFF —
-- the default, and exactly the state of a store whose setup isn't finished.
select adjust_stock(:SKU, -200, 'reset seed opening stock');
update child_skus
   set store_variant_id = 'shopvar-1', store_inventory_item_id = 'inv-1'
 where id = :SKU;
insert into store_connections
  (source, site_id, channel, is_active, sync_inventory_outbound, inventory_location_id)
values ('test.myshopify.com', :MAIN, 'shopify', true, false, 'loc-1');

-- ---- The gap: stock moves while outbound is off -----------------------------
select adjust_stock(:SKU, 50, 'allocate to store before outbound is enabled');
select is(
  (select count(*)::int from store_outbound_inventory_jobs where child_sku_id = :SKU),
  0, 'trigger enqueues NOTHING while the connection has outbound off');

-- Reconcile must respect the same gate: enqueuing here would only manufacture
-- terminal 'skipped' rows, since claim resolves a null channel/source.
select is(
  public.reconcile_outbound_inventory_for_site(:MAIN),
  0, 'reconcile is a no-op for a site with no outbound-enabled connection');

-- ---- Enabling the store must recover the missed movement --------------------
update store_connections set sync_inventory_outbound = true where site_id = :MAIN;

select is(
  public.reconcile_outbound_inventory_for_site(:MAIN),
  1, 'reconcile enqueues the mapped SKU once the store is enabled');
select is(
  (select count(*)::int from store_outbound_inventory_jobs
     where child_sku_id = :SKU and status = 'pending'),
  1, 'exactly one pending job exists for the SKU');
select is(
  (select j.desired_available from store_outbound_inventory_jobs j
     where j.child_sku_id = :SKU and j.status = 'pending'),
  (select (il.on_hand - il.reserved)::int from inventory_levels il
     where il.child_sku_id = :SKU),
  'the enqueued target is the SKU''s CURRENT available, not a stale snapshot');

-- ---- Idempotent: pressing "Re-push all stock" twice must not pile up --------
select is(
  public.reconcile_outbound_inventory_for_site(:MAIN),
  1, 'a second reconcile still reports the SKU');
select is(
  (select count(*)::int from store_outbound_inventory_jobs
     where child_sku_id = :SKU and status = 'pending'),
  1, 'the re-run updates the pending row in place (one-pending-per-SKU held)');

-- ---- Terminal rows are revivable -------------------------------------------
-- A job that went 'skipped' on a bad mapping is terminal in
-- complete_outbound_inventory_job; reconcile is the supported way to retry it
-- once the mapping is fixed.
update store_outbound_inventory_jobs
   set status = 'skipped', processed_at = now(), last_error = 'bad mapping'
 where child_sku_id = :SKU and status = 'pending';
select public.reconcile_outbound_inventory_for_site(:MAIN);
select is(
  (select count(*)::int from store_outbound_inventory_jobs
     where child_sku_id = :SKU and status = 'pending'),
  1, 'reconcile gives a terminally skipped SKU a fresh pending job');

-- ---- Unmapped SKUs stay out of the queue ------------------------------------
delete from store_outbound_inventory_jobs where child_sku_id = :SKU;
update child_skus set store_variant_id = null where id = :SKU;
select is(
  public.reconcile_outbound_inventory_for_site(:MAIN),
  0, 'an unmapped SKU is not enqueued (nothing to address on the store)');

select * from finish();
rollback;
