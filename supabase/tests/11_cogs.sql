-- COGS: product cost is frozen at fulfillment (not creation), never rewritten,
-- and cogs_report computes margin correctly. Seeded SKU has price 12, 200 on hand.
begin;
select plan(6);
\set SKU '''a0000000-0000-0000-0000-000000000001'''
\set A   '''11111111-1111-1111-1111-111111111111'''
\set ORD '''97aa0000-1111-0000-0000-000000000001'''

-- Cost is 4.25 at order creation, then changes to 9.99 before fulfillment.
update child_skus set cost = 4.25 where id = :SKU;
insert into fulfillment_groups(id, site_id)
  values ('97aa0000-0000-0000-0000-000000000001', :A);
insert into orders(id, site_id, group_id)
  values (:ORD, :A, '97aa0000-0000-0000-0000-000000000001');
insert into order_line_items(order_id, child_sku_id, quantity, unit_price)
  values (:ORD, :SKU, 10, 12);
select apply_order_creation(:ORD);

update child_skus set cost = 9.99 where id = :SKU;
select lives_ok($$ select fulfill_order('97aa0000-1111-0000-0000-000000000001') $$,
  'fulfill succeeds');

-- Snapshot captured the cost AT fulfillment (9.99), not at creation (4.25).
select is(
  (select unit_cost_snapshot from order_line_items where order_id = :ORD),
  9.99::numeric, 'cost snapshotted at fulfillment, not at creation');

-- A later cost change must not rewrite the historical snapshot.
update child_skus set cost = 1.00 where id = :SKU;
select is(
  (select unit_cost_snapshot from order_line_items where order_id = :ORD),
  9.99::numeric, 'snapshot is frozen against later cost edits');

-- cogs_report margin math: revenue 120, COGS 10*9.99=99.90, profit 20.10.
select is((select product_cogs from cogs_report where order_id = :ORD),
  99.90::numeric, 'product_cogs = qty * snapshot');
select is((select revenue from cogs_report where order_id = :ORD),
  120.00::numeric, 'revenue = qty * unit_price');
select is((select gross_profit from cogs_report where order_id = :ORD),
  20.10::numeric, 'gross_profit = revenue - discount - COGS');

select * from finish();
rollback;
