-- Migration 0083: sku_commitments must explain the reserved/layby counters.
--
-- The contract the inventory screen depends on:
--   sum(reserved_qty) per stock_child_sku_id = inventory_levels.reserved
--   sum(layby_qty)    per stock_child_sku_id = inventory_levels.layby
-- Anything that holds no stock (backorder, pending_payment, service SKU) must
-- appear with those columns at ZERO, or the "doesn't reconcile" warning on the
-- item page fires on healthy data and the team learns to ignore it.
begin;
select plan(17);
\set SKU '''a0000000-0000-0000-0000-000000000001'''
\set SKU2 '''a0000000-0000-0000-0000-000000000002'''
\set A '''11111111-1111-1111-1111-111111111111'''

create or replace function pg_temp.res(p uuid) returns integer language sql as $$
  select coalesce(sum(reserved_qty), 0)::int
    from public.sku_commitments where stock_child_sku_id = p;
$$;
create or replace function pg_temp.lay(p uuid) returns integer language sql as $$
  select coalesce(sum(layby_qty), 0)::int
    from public.sku_commitments where stock_child_sku_id = p;
$$;

-- ---- 0. Baseline: no open orders, nothing committed ------------------------
select is(pg_temp.res(:SKU), 0, 'baseline: nothing reserved in the view');
select is((select reserved from inventory_levels where child_sku_id=:SKU), 0,
  'baseline: nothing reserved in the counter');

-- ---- 1. Standard order in 'created' ---------------------------------------
insert into fulfillment_groups(id,site_id) values ('97000000-0000-0000-0000-000000000001',:A);
insert into orders(id,site_id,group_id) values ('97000000-1111-0000-0000-000000000001',:A,'97000000-0000-0000-0000-000000000001');
insert into order_line_items(order_id,child_sku_id,quantity,unit_price) values ('97000000-1111-0000-0000-000000000001',:SKU,10,12);
select apply_order_creation('97000000-1111-0000-0000-000000000001');

select is(pg_temp.res(:SKU), 10, 'created order: view reserves 10');
select is(pg_temp.res(:SKU), (select reserved from inventory_levels where child_sku_id=:SKU),
  'created order: view reconciles with the counter');
select is((select commitment_kind from sku_commitments where order_id='97000000-1111-0000-0000-000000000001'),
  'reserved', 'created order classified as reserved');

-- ---- 2. Moving through the pick flow keeps the commitment visible ----------
select set_order_status('97000000-1111-0000-0000-000000000001', 'packed');
select is(pg_temp.res(:SKU), 10, 'packed order still shows its reservation');

-- ---- 3. Fulfilment drops the row (stock consumed, no longer held) ----------
select fulfill_order('97000000-1111-0000-0000-000000000001');
select is(pg_temp.res(:SKU), 0, 'fulfilled order leaves the view');
select is(pg_temp.res(:SKU), (select reserved from inventory_levels where child_sku_id=:SKU),
  'after fulfil: view still reconciles');

-- ---- 4. Backordered line: owed units hold NO stock -------------------------
-- Squeeze stock so the next order is short, then confirm the view reports the
-- reserved part and the backordered part separately.
select adjust_stock(:SKU, -(select on_hand - 3 from inventory_levels where child_sku_id=:SKU),
                    'test: squeeze stock to 3');
insert into fulfillment_groups(id,site_id) values ('97000000-0000-0000-0000-000000000002',:A);
insert into orders(id,site_id,group_id) values ('97000000-1111-0000-0000-000000000002',:A,'97000000-0000-0000-0000-000000000002');
insert into order_line_items(order_id,child_sku_id,quantity,unit_price) values ('97000000-1111-0000-0000-000000000002',:SKU,8,12);
select apply_order_creation('97000000-1111-0000-0000-000000000002', true);   -- allow backorder

select is(pg_temp.res(:SKU), 3, 'backordered order: only the reserved 3 count');
select is(pg_temp.res(:SKU), (select reserved from inventory_levels where child_sku_id=:SKU),
  'backordered order: view reconciles with the counter');
select is((select backordered_qty::int from sku_commitments
            where order_id='97000000-1111-0000-0000-000000000002'), 5,
  'backordered order: the owed 5 are reported separately');

-- ---- 5. Cancellation removes the row --------------------------------------
select cancel_order('97000000-1111-0000-0000-000000000002');
select is(pg_temp.res(:SKU), 0, 'cancelled order leaves the view');

-- ---- 6. Layaway lands in layby, not reserved ------------------------------
insert into fulfillment_groups(id,site_id) values ('97000000-0000-0000-0000-000000000003',:A);
insert into orders(id,site_id,group_id,order_type) values ('97000000-1111-0000-0000-000000000003',:A,'97000000-0000-0000-0000-000000000003','layaway');
insert into order_line_items(order_id,child_sku_id,quantity,unit_price) values ('97000000-1111-0000-0000-000000000003',:SKU2,6,11);
select apply_order_creation('97000000-1111-0000-0000-000000000003');

select is(pg_temp.lay(:SKU2), (select layby from inventory_levels where child_sku_id=:SKU2),
  'layaway: layby_qty reconciles with the layby counter');
select is(pg_temp.res(:SKU2), 0, 'layaway reserves nothing');
select is((select commitment_kind from sku_commitments where order_id='97000000-1111-0000-0000-000000000003'),
  'layby', 'layaway classified as layby');

-- ---- 7. Unpaid (pending_payment) order holds nothing -----------------------
-- A held order is written straight to pending_payment with NOTHING reserved
-- (0071/0072) — which is exactly what the rows below reproduce, deliberately
-- skipping apply_order_creation. It must be VISIBLE (staff need to see the
-- demand) but must not move the reserved total.
insert into fulfillment_groups(id,site_id) values ('97000000-0000-0000-0000-000000000004',:A);
insert into orders(id,site_id,group_id,status,hold_reason,channel)
  values ('97000000-1111-0000-0000-000000000004',:A,'97000000-0000-0000-0000-000000000004','pending_payment','pending','woocommerce');
insert into order_line_items(order_id,child_sku_id,quantity,unit_price)
  values ('97000000-1111-0000-0000-000000000004',:SKU2,4,11);

select is(pg_temp.res(:SKU2), 0, 'unpaid order reserves nothing');
select is((select pending_qty::int from sku_commitments
            where status = 'pending_payment' and stock_child_sku_id = :SKU2), 4,
  'unpaid order is visible with its units in pending_qty');

select * from finish();
rollback;
