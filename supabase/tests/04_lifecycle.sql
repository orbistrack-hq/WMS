-- Order lifecycle: fulfill (consume + bill + status), cancel (release), guards.
begin;
select plan(9);
\set SKU '''a0000000-0000-0000-0000-000000000001'''
\set A '''11111111-1111-1111-1111-111111111111'''

-- standard order: reserve then fulfill
insert into fulfillment_groups(id,site_id) values ('97000000-0000-0000-0000-000000000001',:A);
insert into orders(id,site_id,group_id) values ('97000000-1111-0000-0000-000000000001',:A,'97000000-0000-0000-0000-000000000001');
insert into order_line_items(order_id,child_sku_id,quantity,unit_price) values ('97000000-1111-0000-0000-000000000001',:SKU,10,12);
select apply_order_creation('97000000-1111-0000-0000-000000000001');
select is((select reserved from inventory_levels where child_sku_id=:SKU), 10, 'reserved 10 after creation');

select lives_ok($$ select fulfill_order('97000000-1111-0000-0000-000000000001') $$, 'fulfill succeeds');
select is((select status from orders where id='97000000-1111-0000-0000-000000000001'), 'fulfilled', 'status = fulfilled');
select is((select on_hand from inventory_levels where child_sku_id=:SKU), 190, 'on_hand 200->190 after consume');
select is((select reserved from inventory_levels where child_sku_id=:SKU), 0, 'reservation cleared');
select is((select amount from billing_charges where order_id='97000000-1111-0000-0000-000000000001' and fee_type='pick_fee'),
  3.50::numeric, 'pick fee charged (10u = 3.50)');

-- double fulfill rejected
select throws_ok($$ select fulfill_order('97000000-1111-0000-0000-000000000001') $$, NULL, NULL, 'double fulfill rejected');

-- cancel releases reservation
insert into fulfillment_groups(id,site_id) values ('97000000-0000-0000-0000-000000000002',:A);
insert into orders(id,site_id,group_id) values ('97000000-1111-0000-0000-000000000002',:A,'97000000-0000-0000-0000-000000000002');
insert into order_line_items(order_id,child_sku_id,quantity,unit_price) values ('97000000-1111-0000-0000-000000000002',:SKU,5,12);
select apply_order_creation('97000000-1111-0000-0000-000000000002');
select lives_ok($$ select cancel_order('97000000-1111-0000-0000-000000000002') $$, 'cancel succeeds');
select is((select reserved from inventory_levels where child_sku_id=:SKU), 0, 'reservation released on cancel');

select * from finish();
rollback;
