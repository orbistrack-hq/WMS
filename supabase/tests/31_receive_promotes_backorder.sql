-- receive_stock must auto-promote waiting backorders (migration 0061).
-- Regression guard for WOO-109977: stock received (or allocated, which delegates
-- to receive_stock) left backordered_qty > 0, blocking fulfilment. Mirrors the
-- adjust_stock promotion path in 16_backorder.sql, but exercises receive_stock.
-- Uses seeded SKU WF-HONEY-MAIN (a0000000-...0001, 200 on hand) at site MAIN.
begin;
select plan(7);
\set SKU '''a0000000-0000-0000-0000-000000000001'''

-- ---- Import-style order backorders the shortfall --------------------------
-- avail = 200; ask 250 -> reserve 200, backorder 50, flag the order.
create temp table o1 as select create_order(
  '11111111-1111-1111-1111-111111111111'::uuid,
  '[{"child_sku_id":"a0000000-0000-0000-0000-000000000001","quantity":250}]'::jsonb,
  p_allow_backorder => true) as id;

select is((select backordered_qty from order_line_items
            where order_id=(select id from o1)), 50,
  'setup: 50-unit shortfall recorded as backordered_qty');
select throws_ok($$ select fulfill_order((select id from o1)) $$,
  NULL, NULL, 'setup: cannot fulfill while backordered');

-- ---- receive_stock now promotes the backorder -----------------------------
-- +100 on_hand -> 100 available; the 50 backordered get reserved, flag clears.
select lives_ok($$ select receive_stock(
  'a0000000-0000-0000-0000-000000000001', 100) $$,
  'receive_stock succeeds');
select is((select reserved from inventory_levels where child_sku_id=:SKU), 250,
  'receive promotes the backordered units (reserved now 250)');
select is((select backordered_qty from order_line_items
            where order_id=(select id from o1)), 0,
  'backordered_qty cleared after receive');
select is((select backordered from orders where id=(select id from o1)), false,
  'order flag cleared once whole');

-- ---- Now fulfillable -------------------------------------------------------
select lives_ok($$ select fulfill_order((select id from o1)) $$,
  'fulfill succeeds once receive cleared the backorder');

select * from finish();
rollback;
