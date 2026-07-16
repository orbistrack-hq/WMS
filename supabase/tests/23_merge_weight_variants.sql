-- merge_products conflict rules (migration 0033, relaxed by 0057).
-- Disjoint weights merge cleanly. Since 0057 the child identity is the SKU, so
-- CODED same-weight children fold cleanly too; the only remaining conflict is two
-- UN-CODED (null-sku) children on the same (site, weight) cell of the survivor.
-- MAIN = 1111..., EAST = 2222... (from seed).
begin;
select plan(8);

\set MAIN '''11111111-1111-1111-1111-111111111111'''
\set EAST '''22222222-2222-2222-2222-222222222222'''
\set WA '''a1000000-0000-0000-0000-0000000000a1'''
\set WB '''a1000000-0000-0000-0000-0000000000b1'''
\set CA '''c1000000-0000-0000-0000-0000000000a1'''
\set CB '''c1000000-0000-0000-0000-0000000000b1'''

-- Become an admin (passes is_operator + can_access_site for all sites).
insert into auth.users(id, email) values
  ('00000000-0000-0000-0000-0000000000ae', 'merge-admin@example.com');
update profiles set role='admin' where id='00000000-0000-0000-0000-0000000000ae';
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000ae"}';

-- ---- Case A: disjoint weights at the SAME site should merge cleanly ---------
-- Survivor WA holds 3.5g + 7g at MAIN (its own two weights must NOT self-clash).
-- Loser WB holds 14g at MAIN — a different weight, so no real collision.
insert into products(id, name) values
  ('a1000000-0000-0000-0000-0000000000a1', 'Weighty Strain'),
  ('a1000000-0000-0000-0000-0000000000b1', 'Weighty Strain');
insert into child_skus(product_id, site_id, sku, store_variant_id, price, grams_per_unit, variant_label) values
  ('a1000000-0000-0000-0000-0000000000a1', :MAIN, 'WA-3_5', 'wa35', 10, 3.5, '3.5g'),
  ('a1000000-0000-0000-0000-0000000000a1', :MAIN, 'WA-7',   'wa7',  11, 7,   '7g'),
  ('a1000000-0000-0000-0000-0000000000b1', :MAIN, 'WB-14',  'wb14', 20, 14,  '14g');

select is(
  ((public.merge_products(:WA, array[:WB]::uuid[], true))->>'ok'),
  'true', 'dry run: disjoint-weight merge at same site is allowed');
select is(
  ((public.merge_products(:WA, array[:WB]::uuid[], true))->>'moved')::int,
  1, 'dry run: one child would move');

-- Commit the merge.
create temp table wa_res on commit drop as
  select public.merge_products(:WA, array[:WB]::uuid[], false) as r;
select is((select (r->>'ok') from wa_res), 'true', 'merge commits');
select is(
  (select count(*)::int from child_skus where product_id = :WA),
  3, 'survivor now holds all three weight children');
select is(
  (select is_active from products where id = :WB),
  false, 'emptied loser parent is deactivated');

-- ---- Case B: two CODED same-weight children fold cleanly (post-0057) --------
-- Both parents hold a 3.5g child at EAST, but each has its own SKU. Since 0057
-- the child identity is the SKU (unique per site by child_skus_site_sku_key), so
-- coded same-weight children never collide on a merge — an "ounce special" folds
-- onto a parent that already holds that weight.
insert into products(id, name) values
  ('c1000000-0000-0000-0000-0000000000a1', 'Collide Strain'),
  ('c1000000-0000-0000-0000-0000000000b1', 'Collide Strain');
insert into child_skus(product_id, site_id, sku, store_variant_id, price, grams_per_unit, variant_label) values
  ('c1000000-0000-0000-0000-0000000000a1', :EAST, 'CA-3_5', 'ca35', 10, 3.5, '3.5g'),
  ('c1000000-0000-0000-0000-0000000000b1', :EAST, 'CB-3_5', 'cb35', 10, 3.5, '3.5g');

select is(
  ((public.merge_products(:CA, array[:CB]::uuid[], true))->>'ok'),
  'true', 'dry run: coded same-weight children fold cleanly (no conflict)');
create temp table ca_res on commit drop as
  select public.merge_products(:CA, array[:CB]::uuid[], false) as r;
select is(
  (select count(*)::int from child_skus where product_id = :CA),
  2, 'survivor holds both coded 3.5g children after a clean merge');

-- ---- Case C: two UN-CODED (null-sku) same-weight children still block -------
-- The one collision 0057 preserves: two null-sku children that would land on the
-- same (site, weight) cell of the survivor. child_skus_null_variant_key blocks it.
insert into products(id, name) values
  ('d1000000-0000-0000-0000-0000000000a1', 'Null Collide'),
  ('d1000000-0000-0000-0000-0000000000b1', 'Null Collide');
insert into child_skus(product_id, site_id, sku, price, grams_per_unit, variant_label) values
  ('d1000000-0000-0000-0000-0000000000a1', :EAST, null, 10, 3.5, '3.5g'),
  ('d1000000-0000-0000-0000-0000000000b1', :EAST, null, 10, 3.5, '3.5g');
select throws_ok(
  $$ select public.merge_products('d1000000-0000-0000-0000-0000000000a1',
       array['d1000000-0000-0000-0000-0000000000b1']::uuid[], false) $$,
  '23505', NULL, 'real merge raises on an unresolved null-sku collision');

select * from finish();
rollback;
