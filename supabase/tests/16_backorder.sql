-- Backorder lifecycle: reserve-available + shortfall, manual hard-fail, fulfill
-- guard, auto-promote on restock, and cancel releasing only the reserved part.
-- Uses seeded SKU WF-HONEY-MAIN (a0000000-...0001, 200 on hand) at site MAIN.
begin;
select plan(16);
\set SKU '''a0000000-0000-0000-0000-000000000001'''

-- ---- 1. Import-style order backorders the shortfall ------------------------
-- avail = 200; ask 250 -> reserve 200, backorder 50, flag the order.
create temp table o1 as select create_order(
  '11111111-1111-1111-1111-111111111111'::uuid,
  '[{"child_sku_id":"a0000000-0000-0000-0000-000000000001","quantity":250}]'::jsonb,
  p_allow_backorder => true) as id;

select is((select reserved from inventory_levels where child_sku_id=:SKU), 200,
  'reserves all available (200) when short');
select is((select backordered_qty from order_line_items
            where order_id=(select id from o1)), 50,
  'records the 50-unit shortfall as backordered_qty');
select is((select backordered from orders where id=(select id from o1)), true,
  'order flagged backordered');

-- ---- 2. Manual order (no allow_backorder) still hard-fails -----------------
select throws_ok($$
  select create_order(
    '11111111-1111-1111-1111-111111111111'::uuid,
    '[{"child_sku_id":"a0000000-0000-0000-0000-000000000001","quantity":5}]'::jsonb)
$$, NULL, NULL, 'manual order hard-fails on short stock (no backorder)');

-- ---- 3. Fulfillment blocked while backordered -----------------------------
select throws_ok($$
  select fulfill_order((select id from o1))
$$, NULL, NULL, 'cannot fulfill while units are backordered');

-- ---- 4. Restock auto-promotes the backorder -------------------------------
-- +100 on_hand -> 100 available; the 50 backordered get reserved, flag clears.
select lives_ok($$ select adjust_stock(
  'a0000000-0000-0000-0000-000000000001', 100, 'restock') $$,
  'restock adjustment succeeds');
select is((select reserved from inventory_levels where child_sku_id=:SKU), 250,
  'promotion reserves the backordered units (reserved now 250)');
select is((select backordered_qty from order_line_items
            where order_id=(select id from o1)), 0,
  'backordered_qty cleared after promotion');
select is((select backordered from orders where id=(select id from o1)), false,
  'order flag cleared once whole');

-- ---- 5. Now fulfillable; consume reserved ---------------------------------
select lives_ok($$ select fulfill_order((select id from o1)) $$,
  'fulfill succeeds once nothing is backordered');
select is((select on_hand from inventory_levels where child_sku_id=:SKU), 50,
  'on_hand 50 after consuming 250 of 300');
select is((select reserved from inventory_levels where child_sku_id=:SKU), 0,
  'reserved back to 0 after fulfilment');

-- ---- 6. Cancel releases ONLY the reserved portion of a backordered order ---
-- avail now 50; ask 80 -> reserve 50, backorder 30.
create temp table o2 as select create_order(
  '11111111-1111-1111-1111-111111111111'::uuid,
  '[{"child_sku_id":"a0000000-0000-0000-0000-000000000001","quantity":80}]'::jsonb,
  p_allow_backorder => true) as id;
select is((select reserved from inventory_levels where child_sku_id=:SKU), 50,
  'second order reserves the remaining 50');
select is((select backordered from orders where id=(select id from o2)), true,
  'second order flagged backordered');
select lives_ok($$ select cancel_order((select id from o2)) $$,
  'cancel releases only the reserved 50 (no over-release error)');
select is((select reserved from inventory_levels where child_sku_id=:SKU), 0,
  'reserved back to 0 after cancelling the backordered order');

select * from finish();
rollback;
