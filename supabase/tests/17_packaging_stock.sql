-- Packaging stock (central, migration 0047): receive/adjust into one pool per
-- type (no site), auto-consume on packing, reversal on edit/delete, and
-- negative-on-over-consume. Uses seeded packaging type Standard Box (0.85).
-- Runs as the DB owner (RLS bypassed) but authenticates as an OPERATOR via the
-- JWT, since receive_packaging/adjust_packaging now gate on is_operator(); the
-- client/operator denial itself is covered in 24_client_scoped_packaging_merge.
begin;
select plan(12);
\set BOX  '''11111111-0000-0000-0000-000000000001'''
\set MAIN '''11111111-1111-1111-1111-111111111111'''
\set G    '''c0000000-0000-0000-0000-000000000001'''
\set O    '''c0000000-1111-0000-0000-000000000001'''
\set SKU  '''a0000000-0000-0000-0000-000000000001'''

-- Authenticate as an operator so the ops-role gate passes (auth.uid() reads the
-- JWT claim; the DB role stays owner, so table-level RLS is still bypassed).
insert into auth.users(id, email) values
  ('00000000-0000-0000-0000-0000000000f7', 'pkg-ops@example.com');
update profiles set role='operator' where id='00000000-0000-0000-0000-0000000000f7';
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000f7"}';

-- 1. receive into the central pool
select receive_packaging(:BOX, 100, 'initial stock');
select is(
  (select on_hand from packaging_levels where packaging_type_id=:BOX),
  100, 'receive sets central box on_hand to 100');

-- 2. manual adjustment (signed, note required)
select adjust_packaging(:BOX, -10, 'damaged in storage');
select is(
  (select on_hand from packaging_levels where packaging_type_id=:BOX),
  90, 'adjust -10 leaves central box at 90');

-- 3/4/5. guards
select throws_ok($$ select adjust_packaging('11111111-0000-0000-0000-000000000001',0,'x') $$,
  NULL, NULL, 'zero adjustment rejected');
select throws_ok($$ select adjust_packaging('11111111-0000-0000-0000-000000000001',-1000,'x') $$,
  NULL, NULL, 'adjustment below zero rejected');
select throws_ok($$ select receive_packaging('11111111-0000-0000-0000-000000000001',0,'x') $$,
  NULL, NULL, 'non-positive receive rejected');

-- 6. consume on packing: recording packaging usage decrements the central pool
insert into fulfillment_groups(id, site_id) values (:G, :MAIN);
insert into orders(id, site_id, group_id) values (:O, :MAIN, :G);
insert into order_line_items(order_id, child_sku_id, quantity, unit_price) values (:O, :SKU, 1, 12);
select record_packaging_usage(:G, :BOX, 3);
select is(
  (select on_hand from packaging_levels where packaging_type_id=:BOX),
  87, 'packing 3 boxes consumes central box stock to 87');

-- 7. the consumption is logged in the packaging ledger (site NULL = central)
select ok(
  (select exists(select 1 from packaging_ledger
                  where packaging_type_id=:BOX and site_id is null
                    and reason='consume' and delta_on_hand=-3)),
  'consume movement recorded in packaging_ledger (central)');

-- 8. editing the usage quantity applies the delta (3 -> 5 consumes 2 more)
update packaging_usage set quantity=5 where group_id=:G and packaging_type_id=:BOX;
select is(
  (select on_hand from packaging_levels where packaging_type_id=:BOX),
  85, 'raising usage 3->5 drops central box to 85');

-- 9. removing the usage line gives the stock back
delete from packaging_usage where group_id=:G and packaging_type_id=:BOX;
select is(
  (select on_hand from packaging_levels where packaging_type_id=:BOX),
  90, 'deleting the packaging line restores central box to 90');

-- 10. over-consumption is allowed to go negative (never block a shipment)
select record_packaging_usage(:G, :BOX, 95);
select is(
  (select on_hand from packaging_levels where packaging_type_id=:BOX),
  -5, 'over-consuming drives on_hand negative (not blocked)');

-- 11/12. valuation view reflects negative stock and value
select is(
  (select stock_value from packaging_stock_report where packaging_type_id=:BOX),
  (-5 * 0.85)::numeric, 'stock_value = on_hand * unit_cost');
select is(
  (select is_negative from packaging_stock_report where packaging_type_id=:BOX),
  true, 'view flags negative stock');

select * from finish();
rollback;
