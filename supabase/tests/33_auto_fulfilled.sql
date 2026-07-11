-- auto_fulfilled marker (migration 0063). fulfill_order(p_auto_fulfilled => true)
-- marks a store-completed auto-fulfillment and keeps the backdated completion
-- time; a normal local fulfill leaves the marker false. The flag is exposed on
-- orders_missing_packaging. Uses seeded SKU WF-HONEY-MAIN (a0000000-...0001) at
-- seeded site MAIN (11111111-...1111).
begin;
select plan(4);

-- A) Store-completed auto-fulfillment, backdated to the real ship time.
create temp table o_auto as select create_order(
  '11111111-1111-1111-1111-111111111111'::uuid,
  '[{"child_sku_id":"a0000000-0000-0000-0000-000000000001","quantity":1}]'::jsonb,
  p_channel => 'woocommerce') as id;
select fulfill_order(
  (select id from o_auto), '2026-07-01 12:00:00-07'::timestamptz, true);

select is(
  (select auto_fulfilled from orders where id=(select id from o_auto)),
  true,
  'fulfill_order(p_auto_fulfilled => true) marks the order auto_fulfilled');
select is(
  (select fulfilled_at from orders where id=(select id from o_auto)),
  '2026-07-01 12:00:00-07'::timestamptz,
  'auto-fulfillment keeps the backdated store completion time');
select ok(
  exists(select 1 from orders_missing_packaging
         where order_id=(select id from o_auto) and auto_fulfilled),
  'auto-fulfilled order surfaces on the packaging-gap report, flagged auto_fulfilled');

-- B) A normal local fulfill (defaults) is NOT an auto-fulfillment.
create temp table o_local as select create_order(
  '11111111-1111-1111-1111-111111111111'::uuid,
  '[{"child_sku_id":"a0000000-0000-0000-0000-000000000001","quantity":1}]'::jsonb,
  p_channel => 'woocommerce') as id;
select fulfill_order((select id from o_local));
select is(
  (select auto_fulfilled from orders where id=(select id from o_local)),
  false,
  'a normal local fulfill leaves auto_fulfilled false');

select * from finish();
rollback;
