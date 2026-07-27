-- Migration 0082: deleting an order must return the stock it was holding.
-- Regression guard for the phantom-reservation bug found 2026-07-27, where
-- deleted orders left inventory_levels.reserved inflated with no order left to
-- release it.
begin;
select plan(11);
\set SKU '''a0000000-0000-0000-0000-000000000001'''
\set A '''11111111-1111-1111-1111-111111111111'''

-- ---- 1. Standard order in 'created': delete releases the reservation --------
insert into fulfillment_groups(id,site_id) values ('96000000-0000-0000-0000-000000000001',:A);
insert into orders(id,site_id,group_id) values ('96000000-1111-0000-0000-000000000001',:A,'96000000-0000-0000-0000-000000000001');
insert into order_line_items(order_id,child_sku_id,quantity,unit_price) values ('96000000-1111-0000-0000-000000000001',:SKU,10,12);
select apply_order_creation('96000000-1111-0000-0000-000000000001');
select is((select reserved from inventory_levels where child_sku_id=:SKU), 10, 'reserved 10 after creation');

delete from orders where id='96000000-1111-0000-0000-000000000001';
select is((select reserved from inventory_levels where child_sku_id=:SKU), 0,
  'delete released the reservation');
select is((select on_hand from inventory_levels where child_sku_id=:SKU), 200,
  'delete did NOT touch on_hand');
select is((select count(*)::int from inventory_ledger
            where child_sku_id=:SKU and reason='order_release'), 1,
  'release wrote an order_release ledger row');

-- ---- 2. Fulfilled order: delete must NOT give stock back --------------------
-- The goods shipped. Returning them would invent inventory.
insert into fulfillment_groups(id,site_id) values ('96000000-0000-0000-0000-000000000002',:A);
insert into orders(id,site_id,group_id) values ('96000000-1111-0000-0000-000000000002',:A,'96000000-0000-0000-0000-000000000002');
insert into order_line_items(order_id,child_sku_id,quantity,unit_price) values ('96000000-1111-0000-0000-000000000002',:SKU,4,12);
select apply_order_creation('96000000-1111-0000-0000-000000000002');
select fulfill_order('96000000-1111-0000-0000-000000000002');
select is((select on_hand from inventory_levels where child_sku_id=:SKU), 196, 'on_hand 200->196 after fulfill');

delete from orders where id='96000000-1111-0000-0000-000000000002';
select is((select on_hand from inventory_levels where child_sku_id=:SKU), 196,
  'deleting a fulfilled order leaves on_hand alone');
select is((select reserved from inventory_levels where child_sku_id=:SKU), 0,
  'deleting a fulfilled order leaves reserved at 0');

-- ---- 3. Cancelled order: already released, must not double-release ---------
insert into fulfillment_groups(id,site_id) values ('96000000-0000-0000-0000-000000000003',:A);
insert into orders(id,site_id,group_id) values ('96000000-1111-0000-0000-000000000003',:A,'96000000-0000-0000-0000-000000000003');
insert into order_line_items(order_id,child_sku_id,quantity,unit_price) values ('96000000-1111-0000-0000-000000000003',:SKU,5,12);
select apply_order_creation('96000000-1111-0000-0000-000000000003');
select cancel_order('96000000-1111-0000-0000-000000000003');
delete from orders where id='96000000-1111-0000-0000-000000000003';
select is((select reserved from inventory_levels where child_sku_id=:SKU), 0,
  'deleting a cancelled order does not double-release');

-- ---- 4. Backordered line: release only the portion actually reserved -------
-- Drive on_hand down so the next order is partly short, then confirm the
-- delete gives back only what was truly held.
select adjust_stock(:SKU, -(select on_hand - 3 from inventory_levels where child_sku_id=:SKU),
                    'test: squeeze stock to 3');
insert into fulfillment_groups(id,site_id) values ('96000000-0000-0000-0000-000000000004',:A);
insert into orders(id,site_id,group_id) values ('96000000-1111-0000-0000-000000000004',:A,'96000000-0000-0000-0000-000000000004');
insert into order_line_items(order_id,child_sku_id,quantity,unit_price) values ('96000000-1111-0000-0000-000000000004',:SKU,8,12);
select apply_order_creation('96000000-1111-0000-0000-000000000004', true);   -- allow backorder
select is((select reserved from inventory_levels where child_sku_id=:SKU), 3,
  'reserved 3 of 8; 5 backordered');

delete from orders where id='96000000-1111-0000-0000-000000000004';
select is((select reserved from inventory_levels where child_sku_id=:SKU), 0,
  'delete released only the 3 reserved, not all 8');
select is((select on_hand from inventory_levels where child_sku_id=:SKU), 3,
  'on_hand unchanged by the backordered delete');

select * from finish();
rollback;
