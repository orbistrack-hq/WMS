-- fulfill_order_no_stock (migration 0064): inventory-neutral fulfillment for
-- historical store completions. Releases the reservation, clears backorders,
-- marks fulfilled/backdated/auto_fulfilled, and leaves on_hand untouched — and
-- unlike fulfill_order it is NOT blocked by a backordered line.
-- Uses seeded SKU WF-HONEY-MAIN (a0000000-...0001) at seeded site MAIN.
begin;
select plan(6);
\set SKU '''a0000000-0000-0000-0000-000000000001'''
\set SITE '''11111111-1111-1111-1111-111111111111'''

create temp table inv0 as
  select on_hand, reserved from public.inventory_levels where child_sku_id = :SKU;

-- A) In-stock store order: reserves stock, then no-stock fulfill releases it and
--    leaves on_hand unchanged (net inventory effect = zero).
create temp table oa as select create_order(
  :SITE,
  '[{"child_sku_id":"a0000000-0000-0000-0000-000000000001","quantity":5}]'::jsonb,
  p_channel => 'woocommerce', p_allow_backorder => true) as id;

select is(
  (select reserved from public.inventory_levels where child_sku_id = :SKU),
  (select reserved from inv0) + 5,
  'create_order reserved 5 units');

select fulfill_order_no_stock((select id from oa), '2026-07-01 12:00:00-07'::timestamptz);

select is(
  (select on_hand from public.inventory_levels where child_sku_id = :SKU),
  (select on_hand from inv0),
  'no-stock fulfill leaves on_hand unchanged');
select is(
  (select reserved from public.inventory_levels where child_sku_id = :SKU),
  (select reserved from inv0),
  'no-stock fulfill releases the reservation');
select is(
  (select status from public.orders where id = (select id from oa)),
  'fulfilled',
  'order is marked fulfilled');
select is(
  (select auto_fulfilled from public.orders where id = (select id from oa)),
  true,
  'order is marked auto_fulfilled');

-- B) Backordered order: reserve everything available, then a short order that is
--    fully backordered — no-stock fulfill must still succeed (guard bypassed).
create temp table hog as select create_order(
  :SITE,
  format('[{"child_sku_id":"a0000000-0000-0000-0000-000000000001","quantity":%s}]',
         (select on_hand - reserved from public.inventory_levels where child_sku_id = :SKU))::jsonb,
  p_channel => 'woocommerce', p_allow_backorder => true) as id;
create temp table ob as select create_order(
  :SITE,
  '[{"child_sku_id":"a0000000-0000-0000-0000-000000000001","quantity":3}]'::jsonb,
  p_channel => 'woocommerce', p_allow_backorder => true) as id;

select lives_ok(
  $$ select fulfill_order_no_stock((select id from ob)) $$,
  'no-stock fulfill succeeds even when the order was fully backordered');

select * from finish();
rollback;
