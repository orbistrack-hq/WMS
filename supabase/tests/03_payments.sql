-- Layaway payments and balance.
begin;
select plan(4);
\set SKU '''a0000000-0000-0000-0000-000000000001'''
\set A '''11111111-1111-1111-1111-111111111111'''

insert into fulfillment_groups(id,site_id) values ('98000000-0000-0000-0000-000000000001',:A);
insert into orders(id,site_id,group_id,order_type) values ('98000000-1111-0000-0000-000000000001',:A,'98000000-0000-0000-0000-000000000001','layaway');
insert into order_line_items(order_id,child_sku_id,quantity,unit_price) values ('98000000-1111-0000-0000-000000000001',:SKU,4,10);

select is((select balance from order_payment_summary where order_id='98000000-1111-0000-0000-000000000001'),
  40::numeric, 'opening balance = 40');
select lives_ok($$ select record_order_payment('98000000-1111-0000-0000-000000000001', 15, 'cash') $$, 'record $15');
select lives_ok($$ select record_order_payment('98000000-1111-0000-0000-000000000001', 25, 'card') $$, 'record $25');
select is((select balance from order_payment_summary where order_id='98000000-1111-0000-0000-000000000001'),
  0::numeric, 'balance settled at 0');

select * from finish();
rollback;
