-- transfer_stock / reverse_stock_transfer (migration 0078).
-- Covers: warning gate (cost/SKU mismatch), conservation across sites,
-- paired ledger rows, reversal, reserved-safety, same-product guard, and
-- idempotency. Seed gives Wildflower Honey at Main (WF-HONEY-MAIN, on_hand 200,
-- cost 4.50) and East (WF-HONEY-EAST, on_hand 120, cost 4.60) — different cost
-- AND SKU, so it exercises the warning path.
begin;
select plan(19);

\set WM   '''a0000000-0000-0000-0000-000000000001'''   -- Wildflower @ Main
\set WE   '''a0000000-0000-0000-0000-000000000004'''   -- Wildflower @ East
\set TA   '''39a00000-0000-0000-0000-00000000000a'''   -- twin @ Main
\set TB   '''39a00000-0000-0000-0000-00000000000b'''   -- twin @ East
\set MAIN '''11111111-1111-1111-1111-111111111111'''
\set EAST '''22222222-2222-2222-2222-222222222222'''

-- An admin actor (transfer needs access to both sites; reversal is admin-only).
insert into auth.users(id,email) values
 ('00000000-0000-0000-0000-0000000000a1','admin@example.com');
update profiles set role='admin' where id='00000000-0000-0000-0000-0000000000a1';

-- A separate product with IDENTICAL child SKUs at both sites (no warnings) for
-- the idempotency + same-product-guard checks.
insert into products(id,name,category_id) values
 ('39000000-0000-0000-0000-000000000001','Twin Product','ca000000-0000-0000-0000-000000000002');
insert into child_skus(id,product_id,site_id,sku,price,cost) values
 (:TA,'39000000-0000-0000-0000-000000000001',:MAIN,'TWIN-1',10.00,5.00),
 (:TB,'39000000-0000-0000-0000-000000000001',:EAST,'TWIN-1',10.00,5.00);
select receive_stock('39a00000-0000-0000-0000-00000000000a', 100, 'seed', null, 'opening');

-- Act as the admin for every guarded call below.
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1"}';

-- ---- Section 1: warning gate + basic move (Wildflower Main -> East) ---------
select throws_ok(
  $$ select transfer_stock('a0000000-0000-0000-0000-000000000001',
                           'a0000000-0000-0000-0000-000000000004', 50, 'test', false) $$,
  'WMS01', NULL, 'cost/SKU mismatch is refused without acknowledgement');

select lives_ok(
  $$ select transfer_stock('a0000000-0000-0000-0000-000000000001',
                           'a0000000-0000-0000-0000-000000000004', 50, 'test', true) $$,
  'transfer succeeds once warnings are acknowledged');

select is((select on_hand from inventory_levels where child_sku_id=:WM)::int, 150,
  'source on_hand 200 -> 150');
select is((select on_hand from inventory_levels where child_sku_id=:WE)::int, 170,
  'destination on_hand 120 -> 170');
select is(
  (select count(*)::int from inventory_ledger
    where child_sku_id=:WM and reason='transfer_out' and reference_type='stock_transfer'),
  1, 'transfer_out ledger row on the source');
select is(
  (select count(*)::int from inventory_ledger
    where child_sku_id=:WE and reason='transfer_in' and reference_type='stock_transfer'),
  1, 'transfer_in ledger row on the destination');
select is(
  (select array_length(warnings,1) from stock_transfers
    where source_child_sku_id=:WM and dest_child_sku_id=:WE)::int,
  2, 'both mismatch warnings recorded on the header');

-- ---- Section 2: reversal restores both sites -------------------------------
select lives_ok(
  $$ select reverse_stock_transfer(
       (select id from stock_transfers where source_child_sku_id=:WM
         and dest_child_sku_id=:WE and reversed_at is null limit 1), 'oops') $$,
  'admin can reverse the transfer');
select is((select on_hand from inventory_levels where child_sku_id=:WM)::int, 200,
  'source restored to 200 after reversal');
select is((select on_hand from inventory_levels where child_sku_id=:WE)::int, 120,
  'destination restored to 120 after reversal');
select isnt((select reversed_at from stock_transfers
  where source_child_sku_id=:WM and dest_child_sku_id=:WE limit 1), NULL,
  'header marked reversed');

-- ---- Section 3: reserved units can never be transferred away ----------------
select lives_ok($$ select reserve_stock('a0000000-0000-0000-0000-000000000001', 150) $$,
  'reserve 150 at source (available now 50)');
select throws_ok(
  $$ select transfer_stock('a0000000-0000-0000-0000-000000000001',
                           'a0000000-0000-0000-0000-000000000004', 60, 't', true) $$,
  '23514', NULL, 'cannot transfer more than AVAILABLE (reserved is protected)');

-- ---- Section 4: source and destination must be the same product ------------
select throws_ok(
  $$ select transfer_stock('a0000000-0000-0000-0000-000000000001',
                           '39a00000-0000-0000-0000-00000000000b', 5, 't', true) $$,
  '23514', NULL, 'transfer between different products is rejected');

-- ---- Section 5: idempotency (identical twins, no warnings) ------------------
select lives_ok(
  $$ select transfer_stock('39a00000-0000-0000-0000-00000000000a',
                           '39a00000-0000-0000-0000-00000000000b', 20, 't', false, 'idem-1') $$,
  'twin transfer succeeds (no warnings, keyed)');
select is((select on_hand from inventory_levels where child_sku_id=:TA)::int, 80,
  'twin source 100 -> 80');
select is((select on_hand from inventory_levels where child_sku_id=:TB)::int, 20,
  'twin destination 0 -> 20');
select is(
  (select transfer_stock('39a00000-0000-0000-0000-00000000000a',
                         '39a00000-0000-0000-0000-00000000000b', 20, 't', false, 'idem-1')),
  (select id from stock_transfers where idempotency_key='idem-1'),
  'replaying the same idempotency key returns the same transfer');
select is((select on_hand from inventory_levels where child_sku_id=:TA)::int, 80,
  'replay moved nothing (source still 80)');

select * from finish();
rollback;
