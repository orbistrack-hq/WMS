-- Shopify backfill: cost is seed-only (never clobbers a set cost), and stock
-- syncs into on_hand as a logged, idempotent, reservation-safe movement.
begin;
select plan(9);
\set MAIN '''11111111-1111-1111-1111-111111111111'''
\set SKU  '''a0000000-0000-0000-0000-000000000001'''

-- 1 & 2. Cost seeds on create when Shopify provides one.
select is(
  (select cost_seeded from public.upsert_shopify_variant(
     '11111111-1111-1111-1111-111111111111'::uuid,
     'shopvar-cost-1', 'Beeswax Bar', 'BWX-1', 9.00, 3.50, null)),
  true, 'cost seeded on create');
select is(
  (select cost from child_skus where store_variant_id = 'shopvar-cost-1'),
  3.50::numeric, 'cost set from Shopify on create');

-- 3 & 4. Re-sync with a different Shopify cost must NOT clobber the set cost.
select is(
  (select cost_seeded from public.upsert_shopify_variant(
     '11111111-1111-1111-1111-111111111111'::uuid,
     'shopvar-cost-1', 'Beeswax Bar', 'BWX-1', 9.00, 7.99, null)),
  false, 'cost not re-seeded once WMS has one');
select is(
  (select cost from child_skus where store_variant_id = 'shopvar-cost-1'),
  3.50::numeric, 'existing cost preserved (WMS owns it)');

-- 5 & 6. Stock sync sets on_hand and logs a single shopify_sync ledger row.
select public.upsert_shopify_variant(
  '11111111-1111-1111-1111-111111111111'::uuid,
  'shopvar-inv-1', 'Wax Melts', 'WM-1', 5.00, null, 42);
select is(
  (select il.on_hand from inventory_levels il
     join child_skus cs on cs.id = il.child_sku_id
    where cs.store_variant_id = 'shopvar-inv-1'),
  42, 'on_hand set from Shopify quantity');
select is(
  (select count(*)::int from inventory_ledger l
     join child_skus cs on cs.id = l.child_sku_id
    where cs.store_variant_id = 'shopvar-inv-1' and l.reason = 'shopify_sync'),
  1, 'one shopify_sync ledger row written');

-- 7. Re-syncing the same quantity is a no-op — no extra ledger noise.
select public.upsert_shopify_variant(
  '11111111-1111-1111-1111-111111111111'::uuid,
  'shopvar-inv-1', 'Wax Melts', 'WM-1', 5.00, null, 42);
select is(
  (select count(*)::int from inventory_ledger l
     join child_skus cs on cs.id = l.child_sku_id
    where cs.store_variant_id = 'shopvar-inv-1' and l.reason = 'shopify_sync'),
  1, 're-sync with unchanged quantity adds no ledger row (idempotent)');

-- 8 & 9. Reservations are a floor: a sync below reserved clamps to reserved and
-- never disturbs the reserved count. Seeded SKU starts with 200 on_hand.
select reserve_stock('a0000000-0000-0000-0000-000000000001', 30);
select public.set_on_hand_to('a0000000-0000-0000-0000-000000000001', 5);
select is(
  (select on_hand from inventory_levels where child_sku_id = :SKU),
  30, 'on_hand clamped to reserved, never below committed stock');
select is(
  (select reserved from inventory_levels where child_sku_id = :SKU),
  30, 'reservations untouched by the sync');

select * from finish();
rollback;
