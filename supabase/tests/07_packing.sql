-- Packing: record_packaging_usage snapshots cost; pack_group advances orders.
-- Uses seeded packaging types (Standard Box 0.85, 8oz Jar 0.40) and SKU/site MAIN.
begin;
select plan(9);
\set BOX  '''11111111-0000-0000-0000-000000000001'''
\set JAR  '''11111111-0000-0000-0000-000000000003'''
\set SKU  '''a0000000-0000-0000-0000-000000000001'''
\set MAIN '''11111111-1111-1111-1111-111111111111'''
\set G    '''b0000000-0000-0000-0000-000000000001'''
\set O    '''b0000000-1111-0000-0000-000000000001'''

insert into fulfillment_groups(id, site_id) values (:G, :MAIN);
insert into orders(id, site_id, group_id) values (:O, :MAIN, :G);
insert into order_line_items(order_id, child_sku_id, quantity, unit_price)
  values (:O, :SKU, 2, 12);
select apply_order_creation(:O);

-- record packaging against the GROUP, cost snapshotted
select lives_ok($$ select record_packaging_usage('b0000000-0000-0000-0000-000000000001','11111111-0000-0000-0000-000000000001',1) $$,
  'record 1 box');
select lives_ok($$ select record_packaging_usage('b0000000-0000-0000-0000-000000000001','11111111-0000-0000-0000-000000000003',3) $$,
  'record 3 jars');
select is((select unit_cost_snapshot from packaging_usage
            where group_id=:G and packaging_type_id=:BOX), 0.85::numeric,
  'box cost snapshotted at 0.85');
select is(public.group_packaging_cost(:G), 2.05::numeric,
  'group packaging cost = 0.85 + 3*0.40 = 2.05');

-- quantity guard
select throws_ok($$ select record_packaging_usage('b0000000-0000-0000-0000-000000000001','11111111-0000-0000-0000-000000000001',0) $$,
  NULL, NULL, 'zero quantity rejected');

-- pack the group: order advances to packed, note saved
select lives_ok($$ select pack_group('b0000000-0000-0000-0000-000000000001','handle with care') $$,
  'pack_group succeeds');
select is((select status from orders where id=:O), 'packed', 'order advanced to packed');
select is((select packing_notes from fulfillment_groups where id=:G), 'handle with care',
  'packing note saved');

-- packing a non-open group is rejected
update fulfillment_groups set status='cancelled' where id=:G;
select throws_ok($$ select pack_group('b0000000-0000-0000-0000-000000000001') $$,
  NULL, NULL, 'packing a non-open group rejected');

select * from finish();
rollback;
