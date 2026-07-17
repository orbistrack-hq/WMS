-- Migration 0077: BOGO shared stock (delegating child SKUs).
-- Proves:
--   * reserving/consuming a delegate SKU moves the PAID pool, never the delegate;
--   * a 1-paid + 1-free order reserves 2 and consumes 2 from the paid pool;
--   * availability guard: a 1+1 order with only 1 available fails (no oversell);
--   * receive_stock into a delegate is blocked;
--   * adopt_bogo_sku re-parents, relabels, zeroes price, matches cost, moves
--     trapped stock to the paid pool, and sets the pointer;
--   * auto_adopt_bogo merges an unambiguous twin and leaves an orphan flagged;
--   * delegate guards reject self- and cross-product delegation.
-- MAIN site = 1111... (seeded by fixtures); base pick-fee schedule effective.
begin;
select plan(18);

\set MAIN '''11111111-1111-1111-1111-111111111111'''

insert into auth.users(id, email) values
  ('00000000-0000-0000-0000-0000000000e7', 'bogo2-admin@example.com');
update profiles set role='admin' where id='00000000-0000-0000-0000-0000000000e7';
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000e7"}';

-- Products.
insert into products(id, name) values
  ('f1000000-0000-0000-0000-000000000001', 'Blue Slushie 3.5G'),
  ('f1000000-0000-0000-0000-000000000002', 'Low Stock 3.5G'),
  ('f1000000-0000-0000-0000-000000000003', 'Adopt Paid'),
  ('f1000000-0000-0000-0000-000000000013', 'Adopt Dup'),
  ('f1000000-0000-0000-0000-000000000004', 'Auto Paid'),
  ('f1000000-0000-0000-0000-000000000014', 'Auto Dup'),
  ('f1000000-0000-0000-0000-000000000006', 'Orphan Free');

-- Paid + delegate children.
insert into child_skus(id, product_id, site_id, sku, price, cost) values
  ('f2000000-0000-0000-0000-000000000001','f1000000-0000-0000-0000-000000000001',:MAIN,'BC-BS-3.5G',      25,8),
  ('f2000000-0000-0000-0000-000000000002','f1000000-0000-0000-0000-000000000001',:MAIN,'BC-BS-3.5G-BOGO',  0,8),
  ('f2000000-0000-0000-0000-000000000003','f1000000-0000-0000-0000-000000000002',:MAIN,'LO-1',             9,3),
  ('f2000000-0000-0000-0000-000000000004','f1000000-0000-0000-0000-000000000002',:MAIN,'LO-1-BOGO',        0,3),
  ('f2000000-0000-0000-0000-000000000005','f1000000-0000-0000-0000-000000000003',:MAIN,'ZZ-1',            10,5),
  ('f2000000-0000-0000-0000-000000000006','f1000000-0000-0000-0000-000000000013',:MAIN,'ZZ1',              0,5),
  ('f2000000-0000-0000-0000-000000000007','f1000000-0000-0000-0000-000000000004',:MAIN,'YY-1',            10,5),
  ('f2000000-0000-0000-0000-000000000008','f1000000-0000-0000-0000-000000000014',:MAIN,'YY1',              0,5),
  ('f2000000-0000-0000-0000-000000000010','f1000000-0000-0000-0000-000000000006',:MAIN,'ORPHAN-BOGO',      0,5);

-- Delegate the two proper-suffix BOGOs to their paid twins.
update child_skus set delegates_to_child_sku_id='f2000000-0000-0000-0000-000000000001'
 where id='f2000000-0000-0000-0000-000000000002';
update child_skus set delegates_to_child_sku_id='f2000000-0000-0000-0000-000000000003'
 where id='f2000000-0000-0000-0000-000000000004';

-- Stock: paid pools only.
select receive_stock('f2000000-0000-0000-0000-000000000001', 100);
select receive_stock('f2000000-0000-0000-0000-000000000003', 1);
select receive_stock('f2000000-0000-0000-0000-000000000005', 50);
select receive_stock('f2000000-0000-0000-0000-000000000007', 20);

-- ---- 1. Reserving the delegate moves the PAID pool ---------------------------
select reserve_stock('f2000000-0000-0000-0000-000000000002', 1);
select is((select reserved from inventory_levels where child_sku_id='f2000000-0000-0000-0000-000000000001'), 1,
  'reserving the BOGO reserves the paid pool');
select is((select reserved from inventory_levels where child_sku_id='f2000000-0000-0000-0000-000000000002'), 0,
  'the delegate holds no reservation of its own');
select release_stock('f2000000-0000-0000-0000-000000000002', 1);
select is((select reserved from inventory_levels where child_sku_id='f2000000-0000-0000-0000-000000000001'), 0,
  'releasing the BOGO releases the paid pool');

-- ---- 2. 1 paid + 1 free order reserves 2 on the paid pool --------------------
create temp table ord as select create_order(
  :MAIN,
  '[{"child_sku_id":"f2000000-0000-0000-0000-000000000001","quantity":1},
    {"child_sku_id":"f2000000-0000-0000-0000-000000000002","quantity":1}]'::jsonb) as id;
select is((select reserved from inventory_levels where child_sku_id='f2000000-0000-0000-0000-000000000001'), 2,
  '1 paid + 1 free reserves 2 on the paid pool');
select is((select reserved from inventory_levels where child_sku_id='f2000000-0000-0000-0000-000000000002'), 0,
  'the free line reserves nothing on the delegate');

-- ---- 3. Fulfillment consumes 2 from the paid pool ---------------------------
select fulfill_order((select id from ord));
select is((select on_hand from inventory_levels where child_sku_id='f2000000-0000-0000-0000-000000000001'), 98,
  'fulfilling consumes 2 (paid + free) from the paid pool');
select is((select reserved from inventory_levels where child_sku_id='f2000000-0000-0000-0000-000000000001'), 0,
  'reservation cleared after fulfillment');

-- ---- 4. Availability guard: 1 available, 1+1 order must fail -----------------
select throws_ok($$ select create_order(
  '11111111-1111-1111-1111-111111111111'::uuid,
  '[{"child_sku_id":"f2000000-0000-0000-0000-000000000003","quantity":1},
    {"child_sku_id":"f2000000-0000-0000-0000-000000000004","quantity":1}]'::jsonb) $$,
  '23514', NULL, 'a 1+1 order with only 1 available fails rather than overselling');

-- ---- 5. receive_stock into a delegate is blocked ----------------------------
select throws_ok($$ select receive_stock('f2000000-0000-0000-0000-000000000002', 5) $$,
  '23514', NULL, 'receiving into a delegate SKU is blocked');

-- ---- 6. adopt_bogo_sku: re-parent, relabel, move stock, set pointer ----------
select receive_stock('f2000000-0000-0000-0000-000000000006', 7);   -- trapped stock on the twin
select adopt_bogo_sku('f2000000-0000-0000-0000-000000000006','f2000000-0000-0000-0000-000000000005');
select is((select delegates_to_child_sku_id from child_skus where id='f2000000-0000-0000-0000-000000000006'),
  'f2000000-0000-0000-0000-000000000005'::uuid, 'adopt sets the delegation pointer');
select is((select on_hand from inventory_levels where child_sku_id='f2000000-0000-0000-0000-000000000005'), 57,
  'adopt moves trapped stock (50+7) onto the paid pool');
select is((select on_hand from inventory_levels where child_sku_id='f2000000-0000-0000-0000-000000000006'), 0,
  'adopted BOGO pool is emptied');
select is((select cost from child_skus where id='f2000000-0000-0000-0000-000000000006'), 5::numeric,
  'adopt matches the BOGO cost to the paid SKU');
select is((select product_id from child_skus where id='f2000000-0000-0000-0000-000000000006'),
  'f1000000-0000-0000-0000-000000000003'::uuid, 'adopt re-parents the BOGO onto the paid product');

-- ---- 7. auto_adopt_bogo: merge the unambiguous twin, leave the orphan --------
select auto_adopt_bogo();
select is((select delegates_to_child_sku_id from child_skus where id='f2000000-0000-0000-0000-000000000008'),
  'f2000000-0000-0000-0000-000000000007'::uuid, 'auto-adopt merges the unambiguous YY twin');
select is((select delegates_to_child_sku_id from child_skus where id='f2000000-0000-0000-0000-000000000010'),
  null, 'auto-adopt leaves the orphan (no paid counterpart) flagged for review');

-- ---- 8. Delegate guards -----------------------------------------------------
select throws_ok($$ update child_skus set delegates_to_child_sku_id='f2000000-0000-0000-0000-000000000001'
                     where id='f2000000-0000-0000-0000-000000000001' $$,
  '23514', NULL, 'a SKU cannot delegate to itself');
select throws_ok($$ update child_skus set delegates_to_child_sku_id='f2000000-0000-0000-0000-000000000003'
                     where id='f2000000-0000-0000-0000-000000000002' $$,
  '23514', NULL, 'a SKU cannot delegate to a different product');

select * from finish();
rollback;
