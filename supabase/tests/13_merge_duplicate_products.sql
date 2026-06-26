-- merge_products_by_sku consolidates duplicate parents that share a SKU.
-- MAIN = 1111..., EAST = 2222... (from seed).
begin;
select plan(7);
\set MAIN '''11111111-1111-1111-1111-111111111111'''
\set EAST '''22222222-2222-2222-2222-222222222222'''

-- Two separate parents for the SAME SKU at different sites (old flattened state).
insert into products(id, name) values
  ('77ab0000-0000-0000-0000-00000000000a', 'Dup Honey A'),
  ('77ab0000-0000-0000-0000-00000000000b', 'Dup Honey B');
insert into child_skus(product_id, site_id, sku, store_variant_id, price) values
  ('77ab0000-0000-0000-0000-00000000000a', :MAIN, 'DUP-1', 'svA', 10.00),
  ('77ab0000-0000-0000-0000-00000000000b', :EAST, 'DUP-1', 'svB', 10.00);

select is(
  (select count(distinct product_id)::int from child_skus where sku = 'DUP-1'),
  2, 'two parents share the SKU before merge');

select is(public.merge_products_by_sku(), 1, 'merge consolidates one SKU group');

select is(
  (select count(distinct product_id)::int from child_skus where sku = 'DUP-1'),
  1, 'one master after merge');
select is(
  (select count(*)::int from child_skus where sku = 'DUP-1'),
  2, 'both child SKUs preserved (one per site)');
select is(
  (select count(*)::int from products
    where id in ('77ab0000-0000-0000-0000-00000000000a',
                 '77ab0000-0000-0000-0000-00000000000b')
      and is_active = false),
  1, 'the emptied parent is deactivated');
select is(
  (select count(*)::int from duplicate_products_report where sku = 'DUP-1'),
  0, 'no duplicates remain in the report');

-- Idempotent: nothing left to merge.
select is(public.merge_products_by_sku(), 0, 're-running merges nothing');

select * from finish();
rollback;
