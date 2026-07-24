-- Migration 0078: detect + auto-merge BOGO by the "-BOGO" SKU suffix even when
-- the catalog price is non-zero (storefront zeroes only the order line).
-- Mirrors the real pairs, e.g. paid BC-BS3.5G / free BC-BS-3.5G-BOGO at $80.
-- Proves:
--   * a "-BOGO" SKU at a non-zero catalog price is still flagged;
--   * auto_adopt_bogo merges it to its single base-matched, equal-cost paid twin;
--   * after merge, reserving the BOGO draws from the paid pool.
-- MAIN site = 1111... (seeded by fixtures).
begin;
select plan(4);

\set MAIN '''11111111-1111-1111-1111-111111111111'''

insert into auth.users(id, email) values
  ('00000000-0000-0000-0000-0000000000f8', 'bogo3-admin@example.com');
update profiles set role='admin' where id='00000000-0000-0000-0000-0000000000f8';
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000f8"}';

insert into products(id, name) values
  ('91000000-0000-0000-0000-000000000001', 'Blueberry 3.5G'),
  ('91000000-0000-0000-0000-000000000002', 'Blueberry 3.5G BOGO');

-- Paid unit and its free "-BOGO" twin, both at the SAME non-zero catalog price
-- and the SAME cost, exactly as the storefront ships them.
insert into child_skus(id, product_id, site_id, sku, price, cost) values
  ('92000000-0000-0000-0000-000000000001','91000000-0000-0000-0000-000000000001',:MAIN,'BC-XX3.5G',      80, 9),
  ('92000000-0000-0000-0000-000000000002','91000000-0000-0000-0000-000000000002',:MAIN,'BC-XX-3.5G-BOGO',80, 9);

select receive_stock('92000000-0000-0000-0000-000000000001', 100);

-- 1. Flagged despite a non-zero catalog price (suffix fingerprint).
select is((select suspected_duplicate from child_skus where id='92000000-0000-0000-0000-000000000002'), true,
  'a -BOGO SKU at non-zero catalog price is still flagged');

-- 2. Auto-merge finds the single equal-cost, base-matched paid twin.
select auto_adopt_bogo();
select is((select delegates_to_child_sku_id from child_skus where id='92000000-0000-0000-0000-000000000002'),
  '92000000-0000-0000-0000-000000000001'::uuid,
  'auto-adopt merges the non-zero-price -BOGO to its paid twin');

-- 3. Merge cleared the flag.
select is((select suspected_duplicate from child_skus where id='92000000-0000-0000-0000-000000000002'), false,
  'flag clears once the BOGO is adopted');

-- 4. Reserving the merged BOGO draws from the paid pool.
select reserve_stock('92000000-0000-0000-0000-000000000002', 1);
select is((select reserved from inventory_levels where child_sku_id='92000000-0000-0000-0000-000000000001'), 1,
  'after merge, reserving the BOGO reserves the paid pool');

select * from finish();
rollback;
