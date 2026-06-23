-- Tiered pick fee: first-unit premium PER ORDER (not per combined group),
-- idempotent snapshot, effective-dated resolution.
begin;
select plan(6);
\set SKU '''a0000000-0000-0000-0000-000000000001'''
\set A '''11111111-1111-1111-1111-111111111111'''

-- pure math
select is(pick_fee_amount(1,1.25,0.25), 1.25::numeric, '1 unit = 1.25');
select is(pick_fee_amount(5,1.25,0.25), 2.25::numeric, '5 units = 2.25');

-- combined group: O1 (3 units) + O2 (2 units)
insert into fulfillment_groups(id,site_id) values ('99000000-0000-0000-0000-000000000001',:A);
insert into orders(id,site_id,group_id) values
 ('99000000-1111-0000-0000-000000000001',:A,'99000000-0000-0000-0000-000000000001'),
 ('99000000-1111-0000-0000-000000000002',:A,'99000000-0000-0000-0000-000000000001');
insert into order_line_items(order_id,child_sku_id,quantity,unit_price) values
 ('99000000-1111-0000-0000-000000000001',:SKU,3,12),
 ('99000000-1111-0000-0000-000000000002',:SKU,2,12);

select charge_group_pick_fees('99000000-0000-0000-0000-000000000001');
select is((select amount from billing_charges where order_id='99000000-1111-0000-0000-000000000001' and fee_type='pick_fee'),
  1.75::numeric, 'O1 (3u) = 1.75 (own first-unit)');
select is((select amount from billing_charges where order_id='99000000-1111-0000-0000-000000000002' and fee_type='pick_fee'),
  1.50::numeric, 'O2 (2u) = 1.50 (own first-unit)');

-- idempotent: re-charging makes no duplicates
select charge_group_pick_fees('99000000-0000-0000-0000-000000000001');
select is((select count(*)::int from billing_charges bc join orders o on o.id=bc.order_id
           where o.group_id='99000000-0000-0000-0000-000000000001' and bc.fee_type='pick_fee'),
  2, 'still exactly 2 pick-fee charges after re-charge');

-- effective-dated preview
insert into fee_schedules(effective_from,first_unit_rate,additional_unit_rate) values (current_date+1,1.50,0.30);
select is(calc_order_pick_fee('99000000-1111-0000-0000-000000000001', current_date+1),
  2.10::numeric, 'tomorrow O1 (3u) = 1.50 + 2*0.30 = 2.10');

select * from finish();
rollback;
