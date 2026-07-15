-- Migration 0068/0069: non-inventory (service/fee) child SKUs.
-- Proves:
--   * a fee line (track_inventory=false) reserves nothing, records no backorder,
--     and does NOT flag its order backordered — while a real line on the same
--     order still reserves normally;
--   * fulfillment is never blocked by a fee line and consumes nothing from it;
--   * cancelling a fee-only order never over-releases unreserved stock;
--   * store sync auto-flags a "Shipping Protection" product and ignores its
--     fictional store stock;
--   * is_noninventory_name matches the Route pattern only;
--   * set_child_track_inventory flips the flag for admin/manager and is denied
--     to staff.
-- MAIN = 1111... , real SKU WF-HONEY-MAIN a0..0001 (200 on hand), both seeded.
begin;
select plan(16);

\set MAIN '''11111111-1111-1111-1111-111111111111'''
\set REAL '''a0000000-0000-0000-0000-000000000001'''
\set FEE  '''d2000000-0000-0000-0000-000000000001'''

-- Become an admin (passes is_operator + can_access_site for all sites).
insert into auth.users(id, email) values
  ('00000000-0000-0000-0000-0000000000b8', 'ni-admin@example.com'),
  ('00000000-0000-0000-0000-0000000000b9', 'ni-staff@example.com');
update profiles set role='admin' where id='00000000-0000-0000-0000-0000000000b8';
update profiles set role='staff' where id='00000000-0000-0000-0000-0000000000b9';
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b8"}';

-- Seed a fee (non-inventory) child SKU at MAIN with no real stock.
insert into products(id, name) values
  ('d1000000-0000-0000-0000-000000000001', 'Shipping Protection by Route - 4.95');
insert into child_skus(id, product_id, site_id, sku, price, cost, track_inventory) values
  ('d2000000-0000-0000-0000-000000000001',
   'd1000000-0000-0000-0000-000000000001',
   '11111111-1111-1111-1111-111111111111',
   'ROUTE-PROT-495', 4.95, 0, false);

-- ---- 1. Import order carrying a fee line + a real line ----------------------
create temp table o1 as select create_order(
  :MAIN,
  '[{"child_sku_id":"a0000000-0000-0000-0000-000000000001","quantity":4},
    {"child_sku_id":"d2000000-0000-0000-0000-000000000001","quantity":3}]'::jsonb,
  p_allow_backorder => true) as id;

select is((select reserved from inventory_levels where child_sku_id=:FEE), 0,
  'fee line reserves nothing');
select is((select backordered_qty from order_line_items
            where order_id=(select id from o1) and child_sku_id=:FEE), 0,
  'fee line records no backorder');
select is((select backordered from orders where id=(select id from o1)), false,
  'order is NOT flagged backordered by the fee line');
select is((select reserved from inventory_levels where child_sku_id=:REAL), 4,
  'the real line on the same order still reserves normally');

-- ---- 2. Fulfillment not blocked; fee line consumes nothing ------------------
select lives_ok($$ select fulfill_order((select id from o1)) $$,
  'fulfill succeeds — a fee line never blocks on a phantom backorder');
select is((select on_hand from inventory_levels where child_sku_id=:FEE), 0,
  'fee on_hand untouched by fulfillment');
select is((select on_hand from inventory_levels where child_sku_id=:REAL), 196,
  'real line consumed (200 - 4)');

-- ---- 3. Cancel a fee-only order: no over-release ----------------------------
create temp table o2 as select create_order(
  :MAIN,
  '[{"child_sku_id":"d2000000-0000-0000-0000-000000000001","quantity":2}]'::jsonb,
  p_allow_backorder => true) as id;
select lives_ok($$ select cancel_order((select id from o2)) $$,
  'cancel of a fee-only order does not try to release unreserved stock');
select is((select reserved from inventory_levels where child_sku_id=:FEE), 0,
  'fee reserved still 0 after cancel');

-- ---- 4. Sync auto-flags a protection product and ignores its stock ----------
create temp table synced as
  select child_sku_id from upsert_store_variant(
    :MAIN, 'route-999', 'Shipping Protection by Route - 9.99',
    'ROUTE-999', 9.99, 0, 500, 'shopify');
select is((select track_inventory from child_skus
            where id=(select child_sku_id from synced)), false,
  'sync auto-flags a Shipping Protection product as non-inventory');
select is((select on_hand from inventory_levels
            where child_sku_id=(select child_sku_id from synced)), 0,
  'sync ignores the fee product''s fictional store stock');

-- ---- 5. is_noninventory_name pattern ---------------------------------------
select is(public.is_noninventory_name('Shipping Protection by Route - 3.95'), true,
  'name helper matches Route protection');
select is(public.is_noninventory_name('Wildflower Honey 500g'), false,
  'name helper ignores a real product');

-- ---- 6. set_child_track_inventory toggle (admin) ---------------------------
select lives_ok($$ select set_child_track_inventory(:FEE, true) $$,
  'admin can flip a fee SKU back to tracked inventory');
select is((select track_inventory from child_skus where id=:FEE), true,
  'flag is now true after the toggle');

-- ---- 7. staff is denied the toggle -----------------------------------------
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b9"}';
select throws_ok(
  $$ select set_child_track_inventory('d2000000-0000-0000-0000-000000000001', false) $$,
  '42501', NULL,
  'staff is denied set_child_track_inventory (admin/manager only)');

select * from finish();
rollback;
