-- Migration 0080: revert_bogo_sku (un-merge back to a separate stock number).
-- Proves:
--   * revert detaches the BOGO, restores its own on-hand, leaves the paid pool
--     untouched, and sets the opt-out flag;
--   * auto_adopt_bogo does NOT re-merge an opted-out SKU;
--   * revert is blocked while the SKU has an open order holding reserved stock.
-- MAIN site = 1111... (seeded by fixtures).
begin;
select plan(6);

\set MAIN '''11111111-1111-1111-1111-111111111111'''

insert into auth.users(id, email) values
  ('00000000-0000-0000-0000-0000000000ba', 'bogo5-admin@example.com');
update profiles set role='admin' where id='00000000-0000-0000-0000-0000000000ba';
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000ba"}';

insert into products(id, name) values
  ('95000000-0000-0000-0000-000000000001', 'Revert Paid'),
  ('95000000-0000-0000-0000-000000000002', 'Revert BOGO'),
  ('95000000-0000-0000-0000-000000000003', 'Revert Paid 2'),
  ('95000000-0000-0000-0000-000000000004', 'Revert BOGO 2');

insert into child_skus(id, product_id, site_id, sku, price, cost) values
  ('96000000-0000-0000-0000-000000000001','95000000-0000-0000-0000-000000000001',:MAIN,'RV-1',      50,5),
  ('96000000-0000-0000-0000-000000000002','95000000-0000-0000-0000-000000000002',:MAIN,'RV-1-BOGO',  0,5),
  ('96000000-0000-0000-0000-000000000003','95000000-0000-0000-0000-000000000003',:MAIN,'RW-1',      50,5),
  ('96000000-0000-0000-0000-000000000004','95000000-0000-0000-0000-000000000004',:MAIN,'RW-1-BOGO',  0,5);

select receive_stock('96000000-0000-0000-0000-000000000001', 100);
select receive_stock('96000000-0000-0000-0000-000000000003', 50);

-- Merge both pairs (discard default).
select adopt_bogo_sku('96000000-0000-0000-0000-000000000002','96000000-0000-0000-0000-000000000001');
select adopt_bogo_sku('96000000-0000-0000-0000-000000000004','96000000-0000-0000-0000-000000000003');

-- ---- Revert pair 1, restoring its own stock number of 30 --------------------
select revert_bogo_sku('96000000-0000-0000-0000-000000000002', 30);
select is((select delegates_to_child_sku_id from child_skus where id='96000000-0000-0000-0000-000000000002'),
  null, 'revert detaches the delegation pointer');
select is((select on_hand from inventory_levels where child_sku_id='96000000-0000-0000-0000-000000000002'), 30,
  'revert restores the SKU''s own independent stock number');
select is((select on_hand from inventory_levels where child_sku_id='96000000-0000-0000-0000-000000000001'), 100,
  'the paid pool is left untouched by the revert');
select is((select bogo_merge_opt_out from child_skus where id='96000000-0000-0000-0000-000000000002'), true,
  'revert opts the SKU out of future auto-merge');

-- ---- auto_adopt must not re-merge the opted-out SKU -------------------------
select auto_adopt_bogo();
select is((select delegates_to_child_sku_id from child_skus where id='96000000-0000-0000-0000-000000000002'),
  null, 'auto-adopt does not re-merge an opted-out SKU');

-- ---- Revert blocked while an open order holds reserved stock ----------------
select create_order(:MAIN,
  '[{"child_sku_id":"96000000-0000-0000-0000-000000000004","quantity":1}]'::jsonb);
select throws_ok($$ select revert_bogo_sku('96000000-0000-0000-0000-000000000004') $$,
  '23514', NULL, 'revert is blocked while the SKU has an open order holding reserved stock');

select * from finish();
rollback;
