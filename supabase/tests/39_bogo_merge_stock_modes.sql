-- Migration 0079: adopt_bogo_sku stock modes.
-- Proves:
--   * 'discard' (default) keeps the paid pool and drops the duplicate BOGO count
--     (the "same jars counted twice" case) — never doubles inventory;
--   * 'set' reconciles the paid pool to a fresh physical count and drops the
--     BOGO's number.
-- ('move' is covered in test 37.) MAIN site = 1111... (seeded by fixtures).
begin;
select plan(4);

\set MAIN '''11111111-1111-1111-1111-111111111111'''

insert into auth.users(id, email) values
  ('00000000-0000-0000-0000-0000000000a9', 'bogo4-admin@example.com');
update profiles set role='admin' where id='00000000-0000-0000-0000-0000000000a9';
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a9"}';

insert into products(id, name) values
  ('93000000-0000-0000-0000-000000000001', 'Discard Paid'),
  ('93000000-0000-0000-0000-000000000002', 'Discard BOGO'),
  ('93000000-0000-0000-0000-000000000003', 'Set Paid'),
  ('93000000-0000-0000-0000-000000000004', 'Set BOGO');

insert into child_skus(id, product_id, site_id, sku, price, cost) values
  ('94000000-0000-0000-0000-000000000001','93000000-0000-0000-0000-000000000001',:MAIN,'DC-1',      50, 5),
  ('94000000-0000-0000-0000-000000000002','93000000-0000-0000-0000-000000000002',:MAIN,'DC-1-BOGO',  0, 5),
  ('94000000-0000-0000-0000-000000000003','93000000-0000-0000-0000-000000000003',:MAIN,'ST-1',      50, 5),
  ('94000000-0000-0000-0000-000000000004','93000000-0000-0000-0000-000000000004',:MAIN,'ST-1-BOGO',  0, 5);

-- Same jars counted twice: paid and BOGO each show 100 for the SAME shelf.
select receive_stock('94000000-0000-0000-0000-000000000001', 100);
select receive_stock('94000000-0000-0000-0000-000000000002', 100);
select receive_stock('94000000-0000-0000-0000-000000000003', 100);
select receive_stock('94000000-0000-0000-0000-000000000004', 100);

-- ---- discard (default): keep paid, drop the duplicate ------------------------
select adopt_bogo_sku('94000000-0000-0000-0000-000000000002','94000000-0000-0000-0000-000000000001');
select is((select on_hand from inventory_levels where child_sku_id='94000000-0000-0000-0000-000000000001'), 100,
  'discard keeps the paid pool at its real 100 (does NOT double to 200)');
select is((select on_hand from inventory_levels where child_sku_id='94000000-0000-0000-0000-000000000002'), 0,
  'discard empties the BOGO duplicate count');

-- ---- set: reconcile paid to a fresh count, drop the BOGO's -------------------
select adopt_bogo_sku('94000000-0000-0000-0000-000000000004','94000000-0000-0000-0000-000000000003','set',90);
select is((select on_hand from inventory_levels where child_sku_id='94000000-0000-0000-0000-000000000003'), 90,
  'set reconciles the paid pool to the counted 90');
select is((select on_hand from inventory_levels where child_sku_id='94000000-0000-0000-0000-000000000004'), 0,
  'set empties the BOGO count');

select * from finish();
rollback;
