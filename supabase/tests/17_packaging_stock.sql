-- Packaging stock: per-site receive/adjust, auto-consume on packing, reversal
-- on edit/delete, and negative-on-over-consume. Uses seeded packaging types
-- (Standard Box 0.85) and sites MAIN / EAST.
begin;
select plan(14);
\set BOX  '''11111111-0000-0000-0000-000000000001'''
\set MAIN '''11111111-1111-1111-1111-111111111111'''
\set EAST '''22222222-2222-2222-2222-222222222222'''
\set G    '''c0000000-0000-0000-0000-000000000001'''
\set O    '''c0000000-1111-0000-0000-000000000001'''
\set SKU  '''a0000000-0000-0000-0000-000000000001'''

-- helper expr for the box level at a site
-- (inlined below as subselects)

-- 1. receive at MAIN
select receive_packaging(:BOX, :MAIN, 100, 'initial stock');
select is(
  (select on_hand from packaging_levels where packaging_type_id=:BOX and site_id=:MAIN),
  100, 'receive sets MAIN box on_hand to 100');

-- 2. receiving at EAST is isolated from MAIN
select receive_packaging(:BOX, :EAST, 50, 'east stock');
select is(
  (select on_hand from packaging_levels where packaging_type_id=:BOX and site_id=:EAST),
  50, 'EAST box on_hand is its own 50 (per-site isolation)');

-- 3. manual adjustment (signed, note required)
select adjust_packaging(:BOX, :MAIN, -10, 'damaged in storage');
select is(
  (select on_hand from packaging_levels where packaging_type_id=:BOX and site_id=:MAIN),
  90, 'adjust -10 leaves MAIN box at 90');

-- 4/5/6. guards
select throws_ok($$ select adjust_packaging('11111111-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111',0,'x') $$,
  NULL, NULL, 'zero adjustment rejected');
select throws_ok($$ select adjust_packaging('11111111-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111',-1000,'x') $$,
  NULL, NULL, 'adjustment below zero rejected');
select throws_ok($$ select receive_packaging('11111111-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111',0,'x') $$,
  NULL, NULL, 'non-positive receive rejected');

-- 7. consume on packing: recording packaging usage decrements the group's site
insert into fulfillment_groups(id, site_id) values (:G, :MAIN);
insert into orders(id, site_id, group_id) values (:O, :MAIN, :G);
insert into order_line_items(order_id, child_sku_id, quantity, unit_price) values (:O, :SKU, 1, 12);
select record_packaging_usage(:G, :BOX, 3);
select is(
  (select on_hand from packaging_levels where packaging_type_id=:BOX and site_id=:MAIN),
  87, 'packing 3 boxes consumes MAIN box stock to 87');

-- 8. the consumption is logged in the packaging ledger
select ok(
  (select exists(select 1 from packaging_ledger
                  where packaging_type_id=:BOX and site_id=:MAIN
                    and reason='consume' and delta_on_hand=-3)),
  'consume movement recorded in packaging_ledger');

-- 9. editing the usage quantity applies the delta (3 -> 5 consumes 2 more)
update packaging_usage set quantity=5 where group_id=:G and packaging_type_id=:BOX;
select is(
  (select on_hand from packaging_levels where packaging_type_id=:BOX and site_id=:MAIN),
  85, 'raising usage 3->5 drops MAIN box to 85');

-- 10. removing the usage line gives the stock back
delete from packaging_usage where group_id=:G and packaging_type_id=:BOX;
select is(
  (select on_hand from packaging_levels where packaging_type_id=:BOX and site_id=:MAIN),
  90, 'deleting the packaging line restores MAIN box to 90');

-- 11. over-consumption is allowed to go negative (never block a shipment)
select record_packaging_usage(:G, :BOX, 95);
select is(
  (select on_hand from packaging_levels where packaging_type_id=:BOX and site_id=:MAIN),
  -5, 'over-consuming drives on_hand negative (not blocked)');

-- 12/13. valuation view reflects negative stock and value
select is(
  (select stock_value from packaging_stock_report
    where packaging_type_id=:BOX and site_id=:MAIN),
  (-5 * 0.85)::numeric, 'stock_value = on_hand * unit_cost');
select is(
  (select is_negative from packaging_stock_report
    where packaging_type_id=:BOX and site_id=:MAIN),
  true, 'view flags negative stock');

-- 14. EAST untouched by all of the MAIN activity
select is(
  (select on_hand from packaging_levels where packaging_type_id=:BOX and site_id=:EAST),
  50, 'EAST box stock unchanged throughout');

select * from finish();
rollback;
