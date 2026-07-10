-- Migration 0057: SKU-based child uniqueness (relaxes one-child-per-weight).
-- Proves:
--   * two 28g children of one strain parent coexist at a site when SKUs differ
--     (the "ounce special" the fulfillment team needs);
--   * allocation targets each same-weight child independently;
--   * an un-coded (null-sku) duplicate at the same (product, site, weight) is
--     still blocked by child_skus_null_variant_key;
--   * store sync only adopts an unmapped same-weight child on an EXACT sku match,
--     never hijacking a manual variant.
-- MAIN = 1111... (from seed).
begin;
select plan(14);

\set MAIN   '''11111111-1111-1111-1111-111111111111'''
\set ZOAP   '''e0000000-0000-0000-0000-0000000000d0'''
\set ZP28   '''e0000000-0000-0000-0000-0000000000a1'''
\set ZPOZ   '''e0000000-0000-0000-0000-0000000000a2'''
\set GUAVA  '''e0000000-0000-0000-0000-0000000000d1'''
\set GB1    '''e0000000-0000-0000-0000-0000000000b1'''
\set PAPAYA '''e0000000-0000-0000-0000-0000000000d2'''
\set PC1    '''e0000000-0000-0000-0000-0000000000c1'''
\set MZ     '''e0000000-0000-0000-0000-0000000000e1'''
\set MZL    '''e0000000-0000-0000-0000-0000000000e2'''
\set CZ     '''e0000000-0000-0000-0000-0000000000f1'''
\set CZL    '''e0000000-0000-0000-0000-0000000000f2'''

-- Become an admin (passes is_operator + can_access_site for all sites).
insert into auth.users(id, email) values
  ('00000000-0000-0000-0000-0000000000a7', 'sku-admin@example.com');
update profiles set role='admin' where id='00000000-0000-0000-0000-0000000000a7';
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a7"}';

-- Strain parent with its first 28g child.
insert into products(id, name) values
  ('e0000000-0000-0000-0000-0000000000d0', 'Zoap - Hybrid');
insert into child_skus(id, product_id, site_id, sku, grams_per_unit, variant_label, price) values
  ('e0000000-0000-0000-0000-0000000000a1', :ZOAP, :MAIN, 'ZP-28', 28, '28g', 25);

-- ---- Core fix: a SECOND 28g child with a distinct SKU is now allowed ---------
select lives_ok(
  $$ insert into child_skus(id, product_id, site_id, sku, grams_per_unit, variant_label, price)
     values ('e0000000-0000-0000-0000-0000000000a2',
             'e0000000-0000-0000-0000-0000000000d0',
             '11111111-1111-1111-1111-111111111111',
             'ZP-28-OZ', 28, '28g', 20) $$,
  'a second 28g child inserts when its SKU differs (ounce special)');
select is(
  (select count(*)::int from child_skus
     where product_id = :ZOAP and site_id = :MAIN and grams_per_unit = 28),
  2, 'both 28g children coexist under one parent at one site');

-- ---- Guard kept: un-coded (null sku) duplicate at same weight still blocked --
select lives_ok(
  $$ insert into child_skus(product_id, site_id, sku, grams_per_unit, variant_label, price)
     values ('e0000000-0000-0000-0000-0000000000d0',
             '11111111-1111-1111-1111-111111111111',
             null, 28, '28g', 5) $$,
  'first un-coded 28g child is allowed');
select throws_ok(
  $$ insert into child_skus(product_id, site_id, sku, grams_per_unit, variant_label, price)
     values ('e0000000-0000-0000-0000-0000000000d0',
             '11111111-1111-1111-1111-111111111111',
             null, 28, '28g', 5) $$,
  '23505', NULL, 'a second un-coded 28g child at the same site is refused');

-- ---- Allocation targets each same-weight child independently ----------------
select intake_receive(:ZOAP, 1, 'kg');           -- 1000 g into the central pool
select allocate_parent_stock(
  :ZOAP,
  '[{"child_sku_id":"e0000000-0000-0000-0000-0000000000a1","units":2},
    {"child_sku_id":"e0000000-0000-0000-0000-0000000000a2","units":3}]'::jsonb,
  null, 'test allocation');
select is(
  (select on_hand from inventory_levels where child_sku_id = :ZP28),
  2, 'ZP-28 received its 2 allocated units');
select is(
  (select on_hand from inventory_levels where child_sku_id = :ZPOZ),
  3, 'ZP-28-OZ received its 3 allocated units independently');

-- ---- Sync no-hijack: new store variant, no sku twin -> its own child ---------
insert into products(id, name) values
  ('e0000000-0000-0000-0000-0000000000d1', 'Guava');
insert into child_skus(id, product_id, site_id, sku, grams_per_unit, variant_label, price) values
  ('e0000000-0000-0000-0000-0000000000b1', :GUAVA, :MAIN, 'GVA-28', 28, '28g', 30);
select upsert_store_weight_variant(
  :MAIN, 'sv-guava-oz', 'Guava', 28, 'GVA-OZ', 35, null, null, 'shopify');
select ok(
  (select store_variant_id from child_skus where id = :GB1) is null,
  'manual GVA-28 is not hijacked by a new same-weight store variant');
select is(
  (select count(*)::int from child_skus
     where product_id = :GUAVA and site_id = :MAIN and grams_per_unit = 28),
  2, 'the new store 28g variant created its own child');

-- ---- Sync adoption: exact sku match adopts the unmapped child in place -------
insert into products(id, name) values
  ('e0000000-0000-0000-0000-0000000000d2', 'Papaya');
insert into child_skus(id, product_id, site_id, sku, grams_per_unit, variant_label, price) values
  ('e0000000-0000-0000-0000-0000000000c1', :PAPAYA, :MAIN, 'PAP-28', 28, '28g', 30);
select upsert_store_weight_variant(
  :MAIN, 'sv-pap', 'Papaya', 28, 'PAP-28', 35, null, null, 'shopify');
select is(
  (select store_variant_id from child_skus where id = :PC1),
  'sv-pap', 'an exact-SKU store sync adopts the unmapped child in place');
select is(
  (select count(*)::int from child_skus
     where product_id = :PAPAYA and site_id = :MAIN and grams_per_unit = 28),
  1, 'sku-match adoption does not create a duplicate');

-- ---- Merge: the real workflow — fold an ounce special onto the main parent ---
-- Survivor holds a 28g child; loser is the ounce-special product with its own
-- 28g child at the same site. Distinct SKUs, so the merge must NOT clash (0057).
insert into products(id, name) values
  ('e0000000-0000-0000-0000-0000000000e1', 'Merge Zoap'),
  ('e0000000-0000-0000-0000-0000000000e2', 'Merge Zoap');
insert into child_skus(product_id, site_id, sku, grams_per_unit, variant_label, price) values
  (:MZ,  :MAIN, 'MZ-28',    28, '28g', 25),
  (:MZL, :MAIN, 'MZ-28-OZ', 28, '28g', 20);
select is(
  ((merge_products(:MZ, array[:MZL]::uuid[], true))->>'ok'),
  'true', 'coded ounce special merges cleanly onto a parent with that weight');
select is(
  ((merge_products(:MZ, array[:MZL]::uuid[], false))->>'ok'),
  'true', 'the merge commits');
select is(
  (select count(*)::int from child_skus where product_id = :MZ and grams_per_unit = 28),
  2, 'survivor holds both 28g children after the merge');

-- Two UN-CODED 28g children still conflict — the one guard we kept.
insert into products(id, name) values
  ('e0000000-0000-0000-0000-0000000000f1', 'Clash Zoap'),
  ('e0000000-0000-0000-0000-0000000000f2', 'Clash Zoap');
insert into child_skus(product_id, site_id, sku, grams_per_unit, variant_label, price) values
  (:CZ,  :MAIN, null, 28, '28g', 5),
  (:CZL, :MAIN, null, 28, '28g', 5);
select is(
  ((merge_products(:CZ, array[:CZL]::uuid[], true))->>'ok'),
  'false', 'two un-coded 28g children still refuse to merge');

select * from finish();
rollback;
