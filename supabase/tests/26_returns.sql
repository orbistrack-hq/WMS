-- Order returns (migration 0041): return_order restocks on_hand, logs an
-- 'order_return' ledger row, and flips status to 'returned'; reopen_order
-- re-reserves; the transitions are guarded on non-fulfilled / non-returned
-- orders. SKU a0..01 seeds on_hand 200.
begin;
select plan(10);
\set SKU '''a0000000-0000-0000-0000-000000000001'''
\set A '''11111111-1111-1111-1111-111111111111'''

insert into fulfillment_groups(id,site_id) values ('96000000-0000-0000-0000-000000000001',:A);
insert into orders(id,site_id,group_id) values ('96000000-1111-0000-0000-000000000001',:A,'96000000-0000-0000-0000-000000000001');
insert into order_line_items(order_id,child_sku_id,quantity,unit_price)
  values ('96000000-1111-0000-0000-000000000001',:SKU,10,12);
select apply_order_creation('96000000-1111-0000-0000-000000000001');
select fulfill_order('96000000-1111-0000-0000-000000000001');
select is((select on_hand from inventory_levels where child_sku_id=:SKU), 190,
  'on_hand 200->190 after fulfill');

-- Return the fulfilled order.
select lives_ok(
  $$ select return_order('96000000-1111-0000-0000-000000000001') $$,
  'return_order succeeds on a fulfilled order');
select is((select status from orders where id='96000000-1111-0000-0000-000000000001'),
  'returned', 'status = returned');
select is((select on_hand from inventory_levels where child_sku_id=:SKU), 200,
  'on_hand 190->200 restocked on return');
select isnt((select returned_at from orders where id='96000000-1111-0000-0000-000000000001'),
  null, 'returned_at is stamped');
select is(
  (select count(*) from inventory_ledger where child_sku_id=:SKU and reason='order_return'),
  1::bigint, 'one order_return ledger row written');

-- Re-open the returned order: back to created, stock re-reserved.
select lives_ok(
  $$ select reopen_order('96000000-1111-0000-0000-000000000001') $$,
  'reopen_order succeeds on a returned order');
select is((select status from orders where id='96000000-1111-0000-0000-000000000001'),
  'created', 'status = created after reopen');
select is((select reserved from inventory_levels where child_sku_id=:SKU), 10,
  'reserved 10 again after reopen');

-- Guard: a non-fulfilled (now 'created') order can't be returned.
select throws_ok(
  $$ select return_order('96000000-1111-0000-0000-000000000001') $$,
  NULL, NULL, 'return_order refuses a non-fulfilled order');

select * from finish();
rollback;
