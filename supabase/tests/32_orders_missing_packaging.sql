-- orders_missing_packaging (migration 0062): surfaces fulfilled Shopify/Woo
-- orders whose fulfillment group never had packaging recorded (auto-fulfilled,
-- skipped the packing screen), and clears once packaging is recorded.
-- Uses seeded SKU WF-HONEY-MAIN (a0000000-...0001, 200 on hand) at site MAIN
-- and seeded Standard Box (11111111-0000-...0001).
begin;
select plan(5);
\set SKU '''a0000000-0000-0000-0000-000000000001'''
\set BOX '''11111111-0000-0000-0000-000000000001'''

-- A) Woo order, fulfilled, NO packaging recorded -> should surface.
create temp table o_sync as select create_order(
  '11111111-1111-1111-1111-111111111111'::uuid,
  '[{"child_sku_id":"a0000000-0000-0000-0000-000000000001","quantity":2}]'::jsonb,
  p_channel => 'woocommerce') as id;
select fulfill_order((select id from o_sync));

-- B) Woo order, fulfilled, WITH packaging recorded on its group -> excluded.
create temp table o_packed as select create_order(
  '11111111-1111-1111-1111-111111111111'::uuid,
  '[{"child_sku_id":"a0000000-0000-0000-0000-000000000001","quantity":1}]'::jsonb,
  p_channel => 'woocommerce') as id;
select record_packaging_usage(
  (select group_id from orders where id=(select id from o_packed)), :BOX, 1);
select fulfill_order((select id from o_packed));

-- C) Manual order, fulfilled, no packaging -> excluded (store channels only).
create temp table o_manual as select create_order(
  '11111111-1111-1111-1111-111111111111'::uuid,
  '[{"child_sku_id":"a0000000-0000-0000-0000-000000000001","quantity":1}]'::jsonb,
  p_channel => 'manual') as id;
select fulfill_order((select id from o_manual));

-- D) Woo order still open (unfulfilled) -> excluded.
create temp table o_open as select create_order(
  '11111111-1111-1111-1111-111111111111'::uuid,
  '[{"child_sku_id":"a0000000-0000-0000-0000-000000000001","quantity":1}]'::jsonb,
  p_channel => 'woocommerce') as id;

select ok(
  exists(select 1 from orders_missing_packaging where order_id=(select id from o_sync)),
  'surfaces fulfilled Woo order with no packaging');
select ok(
  not exists(select 1 from orders_missing_packaging where order_id=(select id from o_packed)),
  'excludes fulfilled Woo order whose group has packaging');
select ok(
  not exists(select 1 from orders_missing_packaging where order_id=(select id from o_manual)),
  'excludes manual-channel orders');
select ok(
  not exists(select 1 from orders_missing_packaging where order_id=(select id from o_open)),
  'excludes store orders that are still open');

-- Recording packaging on the surfaced order's group clears it.
select record_packaging_usage(
  (select group_id from orders where id=(select id from o_sync)), :BOX, 1);
select ok(
  not exists(select 1 from orders_missing_packaging where order_id=(select id from o_sync)),
  'clears once packaging is recorded');

select * from finish();
rollback;
