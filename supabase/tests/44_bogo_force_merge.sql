-- Migration 0081: force-merge a BOGO SKU that still holds reserved stock.
-- Proves:
--   * a non-forced merge is still blocked when the BOGO holds a reservation;
--   * a forced merge migrates the reservation onto the paid pool (paid.reserved
--     picks it up, the paid on-hand is unchanged under 'discard');
--   * the open order then fulfils from the paid pool with no stranding.
-- MAIN site = 1111... (seeded by fixtures).
begin;
select plan(6);

\set MAIN '''11111111-1111-1111-1111-111111111111'''

insert into auth.users(id, email) values
  ('00000000-0000-0000-0000-0000000000cb', 'bogo6-admin@example.com');
update profiles set role='admin' where id='00000000-0000-0000-0000-0000000000cb';
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000cb"}';

insert into products(id, name) values
  ('97000000-0000-0000-0000-000000000001', 'Force Paid'),
  ('97000000-0000-0000-0000-000000000002', 'Force BOGO');

insert into child_skus(id, product_id, site_id, sku, price, cost) values
  ('98000000-0000-0000-0000-000000000001','97000000-0000-0000-0000-000000000001',:MAIN,'FM-1',      50,5),
  ('98000000-0000-0000-0000-000000000002','97000000-0000-0000-0000-000000000002',:MAIN,'FM-1-BOGO',  0,5);

select receive_stock('98000000-0000-0000-0000-000000000001', 100);
select receive_stock('98000000-0000-0000-0000-000000000002', 20);   -- duplicate count on the BOGO

-- Open order reserves 5 against the BOGO's OWN pool (pre-merge).
create temp table fo as select create_order(:MAIN,
  '[{"child_sku_id":"98000000-0000-0000-0000-000000000002","quantity":5}]'::jsonb) as id;

-- 1. Non-forced merge is blocked by the reservation.
select throws_ok($$ select adopt_bogo_sku('98000000-0000-0000-0000-000000000002','98000000-0000-0000-0000-000000000001') $$,
  'a non-forced merge refuses while the BOGO holds reserved stock');

-- 2. Force merge migrates the reservation onto the paid pool.
select adopt_bogo_sku('98000000-0000-0000-0000-000000000002','98000000-0000-0000-0000-000000000001','discard',null,true);
select is((select delegates_to_child_sku_id from child_skus where id='98000000-0000-0000-0000-000000000002'),
  '98000000-0000-0000-0000-000000000001'::uuid, 'force merge sets the delegation pointer');
select is((select reserved from inventory_levels where child_sku_id='98000000-0000-0000-0000-000000000001'), 5,
  'the reservation is migrated onto the paid pool');
select is((select on_hand from inventory_levels where child_sku_id='98000000-0000-0000-0000-000000000001'), 100,
  'paid on-hand unchanged under discard (same jars)');
select is((select on_hand from inventory_levels where child_sku_id='98000000-0000-0000-0000-000000000002'), 0,
  'the BOGO duplicate pool is emptied');

-- 3. The open order fulfils from the paid pool — no stranding.
select fulfill_order((select id from fo));
select is((select on_hand from inventory_levels where child_sku_id='98000000-0000-0000-0000-000000000001'), 95,
  'fulfilling the migrated order consumes 5 from the paid pool');

select * from finish();
rollback;
