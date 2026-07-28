-- Migration 0084: store stock seeds on create and is never re-applied.
--
-- Regression guard for the one-way ratchet found 2026-07-27, where every product
-- sync pushed the store's count into on_hand via set_on_hand_to. Because that
-- clamps only with greatest(target, reserved, 0), a store count below the WMS
-- count reduced on_hand, and store sales got subtracted twice (order_consume at
-- fulfillment, then again on the next sync). It drained exactly 539 g of Blue
-- Slushie over 12 days.
--
-- Rule now: the store SEEDS on create, WMS OWNS thereafter — same policy the
-- cost field has always followed in this function.
begin;
select plan(10);
\set MAIN '''11111111-1111-1111-1111-111111111111'''
\set WF   '''a0000000-0000-0000-0000-000000000001'''

-- ---- 1. Create seeds opening stock from the store --------------------------
select public.upsert_store_variant(
  '11111111-1111-1111-1111-111111111111'::uuid,
  'seedvar-1', 'Seeded Candle', 'SEED-1', 5.00, null, 42);

select is(
  (select il.on_hand from inventory_levels il
     join child_skus cs on cs.id = il.child_sku_id
    where cs.store_variant_id = 'seedvar-1'),
  42, 'opening stock seeded from the store on create');

select is(
  (select count(*)::int from inventory_ledger l
     join child_skus cs on cs.id = l.child_sku_id
    where cs.store_variant_id = 'seedvar-1' and l.reason = 'shopify_sync'),
  1, 'one shopify_sync ledger row on create');

-- ---- 2. THE FIX: a later sync with a DIFFERENT count is ignored ------------
-- Pre-0083 this drove on_hand down to 7. That is the whole bug.
select public.upsert_store_variant(
  '11111111-1111-1111-1111-111111111111'::uuid,
  'seedvar-1', 'Seeded Candle', 'SEED-1', 5.00, null, 7);

select is(
  (select il.on_hand from inventory_levels il
     join child_skus cs on cs.id = il.child_sku_id
    where cs.store_variant_id = 'seedvar-1'),
  42, 'a later store count does NOT move on_hand (WMS owns it)');

select is(
  (select count(*)::int from inventory_ledger l
     join child_skus cs on cs.id = l.child_sku_id
    where cs.store_variant_id = 'seedvar-1' and l.reason = 'shopify_sync'),
  1, 're-sync writes no further ledger row');

-- ---- 3. Adopting an existing WMS SKU must not take the store's count -------
-- Path 2a: a child that already exists in WMS (seed: WF-HONEY-MAIN, on_hand 200)
-- gets bound to a store variant for the first time. v_created is false there, so
-- the store's number must be ignored — that balance is WMS-owned already.
select public.upsert_store_variant(
  '11111111-1111-1111-1111-111111111111'::uuid,
  'adoptvar-1', 'Wildflower Honey', 'WF-HONEY-MAIN', 12.00, null, 3);

select is(
  (select store_variant_id from child_skus where id = :WF),
  'adoptvar-1', 'existing SKU adopted onto the store variant (path 2a taken)');

select is(
  (select on_hand from inventory_levels where child_sku_id = :WF),
  200, 'adopting an existing SKU leaves its on_hand alone');

select is(
  (select count(*)::int from inventory_ledger
    where child_sku_id = :WF and reason = 'shopify_sync'),
  0, 'adoption writes no stock movement at all');

-- ---- 4. THE WEIGHT-VARIANT PATH (migration 0085) ---------------------------
-- import-products.ts routes to upsert_store_weight_variant whenever the
-- variation parses as a weight, which is nearly the whole cannabis catalog.
-- 0084 fixed only the other RPC, so this path kept draining — a Woo sync on
-- 2026-07-27 17:55 wrote five fresh negative rows after 0084 was live.
select public.upsert_store_weight_variant(
  '11111111-1111-1111-1111-111111111111'::uuid,
  'weightvar-1', 'Seeded Strain', 3.5, 'SEEDW-1', 40.00, 9.00, 30);

select is(
  (select il.on_hand from inventory_levels il
     join child_skus cs on cs.id = il.child_sku_id
    where cs.store_variant_id = 'weightvar-1'),
  30, 'weight variant seeds opening stock on create');

select public.upsert_store_weight_variant(
  '11111111-1111-1111-1111-111111111111'::uuid,
  'weightvar-1', 'Seeded Strain', 3.5, 'SEEDW-1', 40.00, 9.00, 4);

select is(
  (select il.on_hand from inventory_levels il
     join child_skus cs on cs.id = il.child_sku_id
    where cs.store_variant_id = 'weightvar-1'),
  30, 'a later store count does NOT move a weight variant''s on_hand');

select is(
  (select count(*)::int from inventory_ledger l
     join child_skus cs on cs.id = l.child_sku_id
    where cs.store_variant_id = 'weightvar-1' and l.reason = 'shopify_sync'),
  1, 'weight-variant re-sync writes no further ledger row');

select * from finish();
rollback;
