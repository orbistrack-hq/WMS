-- merge_products is weight-variant aware (migration 0033).
-- Pre-0033 it grouped conflicts by SITE alone, so a parent's own weight
-- children at one site self-clashed and blocked the merge. Now a conflict is a
-- genuine duplicate (site, weight) cell; disjoint weights merge cleanly.
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

-- ---- Case B: a genuine (site, weight) collision still blocks ----------------
-- Both parents hold a 3.5g child at EAST — the same physical cell.
insert into products(id, name) values
  ('c1000000-0000-0000-0000-0000000000a1', 'Collide Strain'),
  ('c1000000-0000-0000-0000-0000000000b1', 'Collide Strain');
insert into child_skus(product_id, site_id, sku, store_variant_id, price, grams_per_unit, variant_label) values
  ('c1000000-0000-0000-0000-0000000000a1', :EAST, 'CA-3_5', 'ca35', 10, 3.5, '3.5g'),
  ('c1000000-0000-0000-0000-0000000000b1', :EAST, 'CB-3_5', 'cb35', 10, 3.5, '3.5g');

select is(
  ((public.merge_products(:CA, array[:CB]::uuid[], true))->>'ok'),
  'false', 'dry run: same site+weight collision is refused');
select is(
  (select jsonb_array_length((public.merge_products(:CA, array[:CB]::uuid[], true))->'conflicts')),
  1, 'dry run: exactly one colliding cell reported');
select throws_ok(
  $$ select public.merge_products('c1000000-0000-0000-0000-0000000000a1',
       array['c1000000-0000-0000-0000-0000000000b1']::uuid[], false) $$,
  '23505', NULL, 'real merge raises on an unresolved collision');

select * from finish();
rollback;
