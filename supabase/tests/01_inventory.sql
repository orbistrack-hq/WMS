-- Reservation lifecycle, oversell guard, layaway, adjustment.
-- Uses seeded SKU WF-HONEY-MAIN (a0000000-...0001) with 200 on hand.
begin;
select plan(11);
\set SKU '''a0000000-0000-0000-0000-000000000001'''

select lives_ok($$ select reserve_stock('a0000000-0000-0000-0000-000000000001', 30) $$, 'reserve 30 succeeds');
select is((select reserved from inventory_levels where child_sku_id=:SKU), 30, 'reserved = 30');
select is((select available from inventory_levels where child_sku_id=:SKU), 170, 'available = 170');

select lives_ok($$ select release_stock('a0000000-0000-0000-0000-000000000001', 10) $$, 'release 10 succeeds');
select is((select reserved from inventory_levels where child_sku_id=:SKU), 20, 'reserved = 20 after release');

select lives_ok($$ select consume_stock('a0000000-0000-0000-0000-000000000001', 20) $$, 'consume 20 succeeds');
select is((select on_hand from inventory_levels where child_sku_id=:SKU), 180, 'on_hand = 180 after consume');
select is((select reserved from inventory_levels where child_sku_id=:SKU), 0, 'reserved = 0 after consume');

-- oversell guard
select throws_ok($$ select reserve_stock('a0000000-0000-0000-0000-000000000001', 100000) $$,
  '23514', NULL, 'reserving beyond available is rejected');

-- layaway removes from on_hand now, tracks in layby
select lives_ok($$ select layaway_book('a0000000-0000-0000-0000-000000000001', 5) $$, 'layaway_book 5 succeeds');
select is((select layby from inventory_levels where child_sku_id=:SKU), 5, 'layby = 5 after booking');

select * from finish();
rollback;
