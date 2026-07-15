-- force_fulfill_order: admin/manager-only, inventory-neutral override of the
-- backorder guard (releases reserved, leaves on_hand, clears backorder, audits
-- the reason, charges the pick fee). Plus the backorder_report view.
begin;
select plan(15);

\set SKU  '''a0000000-0000-0000-0000-000000000003'''
\set SKU2 '''a0000000-0000-0000-0000-000000000002'''
\set MAIN '''11111111-1111-1111-1111-111111111111'''
\set G1   '''98000000-0000-0000-0000-000000000001'''
\set O1   '''98000000-1111-0000-0000-000000000001'''
\set G2   '''98000000-0000-0000-0000-000000000002'''
\set O2   '''98000000-1111-0000-0000-000000000002'''

-- Two users: an admin (may force-fulfill) and a plain operator (may not).
insert into auth.users(id,email) values
 ('00000000-0000-0000-0000-0000000000a1','admin@example.com'),
 ('00000000-0000-0000-0000-0000000000c1','op2@example.com');
update profiles set role='admin'    where id='00000000-0000-0000-0000-0000000000a1';
update profiles set role='operator' where id='00000000-0000-0000-0000-0000000000c1';

-- Backordered order 1: qty 90 of a SKU with on_hand 80 -> reserve 80, backorder 10.
insert into fulfillment_groups(id,site_id) values (:G1,:MAIN);
insert into orders(id,site_id,group_id) values (:O1,:MAIN,:G1);
insert into order_line_items(order_id,child_sku_id,quantity,unit_price) values (:O1,:SKU,90,9);
select apply_order_creation(:O1, true);

select is((select reserved from inventory_levels where child_sku_id=:SKU)::int, 80, 'reserved 80 (all available)');
select is((select backordered_qty from order_line_items where order_id=:O1)::int, 10, 'backordered_qty 10 (shortfall)');
select is((select backordered from orders where id=:O1), true, 'order flagged backordered');

-- The view surfaces the open backordered line before fulfillment.
select is((select count(*)::int from backorder_report where order_id=:O1), 1, 'backorder_report shows the open line');
select is((select backordered_qty from backorder_report where order_id=:O1)::int, 10, 'view reports 10 units owed');

-- Normal fulfill is blocked while backordered.
select throws_ok($$ select fulfill_order('98000000-1111-0000-0000-000000000001') $$,
  NULL, NULL, 'fulfill_order blocked while backordered');

-- Force-fulfill as the admin, with a reason.
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1"}';
select lives_ok(
  $$ select force_fulfill_order('98000000-1111-0000-0000-000000000001','shipped from overflow stock') $$,
  'admin force-fulfill succeeds');
reset role;

select is((select status from orders where id=:O1), 'fulfilled', 'status = fulfilled');
select is((select force_fulfilled from orders where id=:O1), true, 'force_fulfilled marker set');
select is((select on_hand from inventory_levels where child_sku_id=:SKU)::int, 80,
  'on_hand UNCHANGED (inventory-neutral)');
select is((select reserved from inventory_levels where child_sku_id=:SKU)::int, 0,
  'reservation released');
select is((select backordered from orders where id=:O1), false, 'backorder flag cleared');
select is(
  (select count(*)::int from inventory_ledger
    where reference_type='order' and reference_id=:O1 and reason='correction'),
  1, 'audit correction row written with the reason');
select is(
  (select count(*)::int from billing_charges
    where order_id=:O1 and fee_type='pick_fee'),
  1, 'pick fee charged (locally packed)');

-- A plain operator cannot force-fulfill: role gate raises before any mutation.
insert into fulfillment_groups(id,site_id) values (:G2,:MAIN);
insert into orders(id,site_id,group_id) values (:O2,:MAIN,:G2);
insert into order_line_items(order_id,child_sku_id,quantity,unit_price) values (:O2,:SKU2,160,11);
select apply_order_creation(:O2, true);

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1"}';
select throws_ok(
  $$ select force_fulfill_order('98000000-1111-0000-0000-000000000002','nope') $$,
  NULL, NULL, 'operator is denied (admin/manager only)');
reset role;

select * from finish();
rollback;
