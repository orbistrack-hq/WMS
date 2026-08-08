-- Shopify backfill: the STORE owns cost — a positive store cost overwrites on
-- every sync (0088), while null/zero leaves the WMS value alone. Stock, by
-- contrast, syncs into on_hand as a logged, idempotent, reservation-safe
-- movement and seeds on create only (0084).
begin;
select plan(13);
\set MAIN '''11111111-1111-1111-1111-111111111111'''
\set SKU  '''a0000000-0000-0000-0000-000000000001'''

-- 1 & 2. Cost lands on create when Shopify provides one.
select is(
  (select cost_seeded from public.upsert_store_variant(
     '11111111-1111-1111-1111-111111111111'::uuid,
     'shopvar-cost-1', 'Beeswax Bar', 'BWX-1', 9.00, 3.50, null)),
  true, 'cost written on create');
select is(
  (select cost from child_skus where store_variant_id = 'shopvar-cost-1'),
  3.50::numeric, 'cost set from Shopify on create');

-- 3 & 4. Re-sync with a NEW Shopify cost overwrites the existing one (0088).
-- This is the whole point of the migration: editing cost in the store moves it
-- in WMS, exactly like price already did.
select is(
  (select cost_seeded from public.upsert_store_variant(
     '11111111-1111-1111-1111-111111111111'::uuid,
     'shopvar-cost-1', 'Beeswax Bar', 'BWX-1', 9.00, 7.99, null)),
  true, 'cost re-written on every sync, not just the first');
select is(
  (select cost from child_skus where store_variant_id = 'shopvar-cost-1'),
  7.99::numeric, 'store cost overwrites the WMS cost');

-- 5 & 6. A null cost means "the store sent nothing" (Woo core has no cost field
-- at all) and must never wipe the WMS value.
select is(
  (select cost_seeded from public.upsert_store_variant(
     '11111111-1111-1111-1111-111111111111'::uuid,
     'shopvar-cost-1', 'Beeswax Bar', 'BWX-1', 9.00, null, null)),
  false, 'null store cost is not a write');
select is(
  (select cost from child_skus where store_variant_id = 'shopvar-cost-1'),
  7.99::numeric, 'null store cost leaves the WMS cost intact');

-- 7 & 8. A zero cost is indistinguishable from an unfilled field, so it is
-- likewise ignored. Without this guard one sync of a catalog whose COG plugin
-- reports 0 would zero out every cost in WMS (and inventory valuation with it),
-- and would flatten BOGO give-away costs matched by adopt_bogo_sku.
select is(
  (select cost_seeded from public.upsert_store_variant(
     '11111111-1111-1111-1111-111111111111'::uuid,
     'shopvar-cost-1', 'Beeswax Bar', 'BWX-1', 9.00, 0, null)),
  false, 'zero store cost is not a write');
select is(
  (select cost from child_skus where store_variant_id = 'shopvar-cost-1'),
  7.99::numeric, 'zero store cost cannot flatten the WMS cost');

-- 9 & 10. Stock sync sets on_hand and logs a single shopify_sync ledger row.
select public.upsert_store_variant(
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

-- 11. Re-syncing the same quantity is a no-op — no extra ledger noise.
select public.upsert_store_variant(
  '11111111-1111-1111-1111-111111111111'::uuid,
  'shopvar-inv-1', 'Wax Melts', 'WM-1', 5.00, null, 42);
select is(
  (select count(*)::int from inventory_ledger l
     join child_skus cs on cs.id = l.child_sku_id
    where cs.store_variant_id = 'shopvar-inv-1' and l.reason = 'shopify_sync'),
  1, 're-sync with unchanged quantity adds no ledger row (idempotent)');

-- 12 & 13. Reservations are a floor: a sync below reserved clamps to reserved and
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
