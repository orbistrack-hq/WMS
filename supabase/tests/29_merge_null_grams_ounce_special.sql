-- Migration 0058: redeploy of the 0057 SKU-identity conflict rule.
-- Regression for the exact production case the fulfillment team hit — an ounce
-- special ("-OS") and other variants carrying NO weight (grams_per_unit NULL)
-- but their own SKUs, on two separate products at the same site. The old
-- per-weight rule folded every null-grams child to wkey -1 and flagged them as a
-- clash ("both products hold a SKU at the same site: BC-BS-3.5G, BC-BS-OS").
-- Test 28 covers the same-28g case; this one locks the null-grams case.
-- MAIN = 1111... (from seed).
begin;
select plan(6);

\set MAIN  '''11111111-1111-1111-1111-111111111111'''
\set SURV  '''a9000000-0000-0000-0000-0000000000d1'''
\set LOSE  '''a9000000-0000-0000-0000-0000000000d2'''
\set NULLA '''a9000000-0000-0000-0000-0000000000c1'''
\set NULLB '''a9000000-0000-0000-0000-0000000000c2'''

-- Become an admin (passes is_operator + can_access_site for all sites).
insert into auth.users(id, email) values
  ('a9000000-0000-0000-0000-0000000000a7', 'null-merge-admin@example.com');
update profiles set role='admin' where id='a9000000-0000-0000-0000-0000000000a7';
set local request.jwt.claims = '{"sub":"a9000000-0000-0000-0000-0000000000a7"}';

-- Survivor "Blue Slushie" with a coded, weightless 3.5g-style child (null grams).
insert into products(id, name) values
  ('a9000000-0000-0000-0000-0000000000d1', 'Blue Slushie');
insert into child_skus(product_id, site_id, sku, grams_per_unit, price) values
  ('a9000000-0000-0000-0000-0000000000d1', :MAIN, 'BC-BS-3.5G', null, 35);

-- Loser is a SEPARATE product carrying the ounce special — also null grams,
-- distinct SKU, same site. This is the pair prod refused to merge.
insert into products(id, name) values
  ('a9000000-0000-0000-0000-0000000000d2', 'Blue Slushie Ounce Special');
insert into child_skus(product_id, site_id, sku, grams_per_unit, price) values
  ('a9000000-0000-0000-0000-0000000000d2', :MAIN, 'BC-BS-OS', null, 120);

-- ---- The fix: distinct-SKU null-grams children merge WITHOUT a conflict ------
select is(
  ((merge_products(:SURV, array[:LOSE]::uuid[], true))->'conflicts'),
  '[]'::jsonb, 'dry run reports no conflict for two coded null-grams children');
select is(
  ((merge_products(:SURV, array[:LOSE]::uuid[], true))->>'ok'),
  'true', 'dry run is ok');
select is(
  ((merge_products(:SURV, array[:LOSE]::uuid[], false))->>'ok'),
  'true', 'the merge commits');
select is(
  (select count(*)::int from child_skus where product_id = :SURV),
  2, 'both null-grams children now sit under the survivor parent');
select ok(
  (select not is_active from products where id = :LOSE),
  'the emptied loser product is deactivated');

-- ---- Guard kept: two UN-CODED null-grams children still clash ----------------
insert into products(id, name) values
  ('a9000000-0000-0000-0000-0000000000c1', 'No Code A'),
  ('a9000000-0000-0000-0000-0000000000c2', 'No Code B');
insert into child_skus(product_id, site_id, sku, grams_per_unit, price) values
  (:NULLA, :MAIN, null, null, 5),
  (:NULLB, :MAIN, null, null, 5);
select is(
  ((merge_products(:NULLA, array[:NULLB]::uuid[], true))->>'ok'),
  'false', 'two un-coded null-grams children still refuse to merge');

select * from finish();
rollback;
