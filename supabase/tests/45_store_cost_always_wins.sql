-- Migration 0088 on the WEIGHT-variant path (upsert_store_weight_variant), the
-- route almost the entire cannabis catalog takes. 0084/0085 showed these two
-- functions drift apart, so the cost rule is asserted on both independently:
-- test 09 covers upsert_store_variant, this file covers the weight path.
--
-- Rule: a POSITIVE store cost overwrites child_skus.cost on every sync; null or
-- zero means "the store sent nothing" and leaves the WMS cost alone. Stock is
-- unaffected and still seeds on create only (0085, asserted in tests 21 and 42).
begin;
select plan(8);

\set MAIN '''11111111-1111-1111-1111-111111111111'''

-- 1 & 2. Cost lands on create.
select is(
  (select cost_seeded from public.upsert_store_weight_variant(
     '11111111-1111-1111-1111-111111111111'::uuid, 'sv-cost-3_5',
     'Cost Kush', 3.5, 'CK-3.5', 40, 12.00, null, 'woocommerce')),
  true, 'weight path: cost written on create');
select is(
  (select cost from child_skus where store_variant_id = 'sv-cost-3_5' and site_id = :MAIN),
  12.00::numeric, 'weight path: cost set from the store on create');

-- 3 & 4. A new store cost overwrites on re-sync — the 0088 behaviour change.
select is(
  (select cost_seeded from public.upsert_store_weight_variant(
     '11111111-1111-1111-1111-111111111111'::uuid, 'sv-cost-3_5',
     'Cost Kush', 3.5, 'CK-3.5', 40, 14.50, null, 'woocommerce')),
  true, 'weight path: cost re-written on every sync');
select is(
  (select cost from child_skus where store_variant_id = 'sv-cost-3_5' and site_id = :MAIN),
  14.50::numeric, 'weight path: store cost overwrites the WMS cost');

-- 5 & 6. Null cost (Woo with no Cost-of-Goods plugin meta) is not a write.
select is(
  (select cost_seeded from public.upsert_store_weight_variant(
     '11111111-1111-1111-1111-111111111111'::uuid, 'sv-cost-3_5',
     'Cost Kush', 3.5, 'CK-3.5', 40, null, null, 'woocommerce')),
  false, 'weight path: null store cost is not a write');
select is(
  (select cost from child_skus where store_variant_id = 'sv-cost-3_5' and site_id = :MAIN),
  14.50::numeric, 'weight path: null store cost leaves the WMS cost intact');

-- 7 & 8. Zero cost is likewise ignored: it cannot be told apart from an empty
-- field, and honouring it would flatten costs across the catalog on one sync.
select is(
  (select cost_seeded from public.upsert_store_weight_variant(
     '11111111-1111-1111-1111-111111111111'::uuid, 'sv-cost-3_5',
     'Cost Kush', 3.5, 'CK-3.5', 40, 0, null, 'woocommerce')),
  false, 'weight path: zero store cost is not a write');
select is(
  (select cost from child_skus where store_variant_id = 'sv-cost-3_5' and site_id = :MAIN),
  14.50::numeric, 'weight path: zero store cost cannot flatten the WMS cost');

select * from finish();
rollback;
