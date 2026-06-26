-- Shopify sync attaches by SKU instead of flattening into duplicate parents.
-- MAIN = 1111..., EAST = 2222... (from seed).
begin;
select plan(7);
\set MAIN '''11111111-1111-1111-1111-111111111111'''
\set EAST '''22222222-2222-2222-2222-222222222222'''

-- A new SKU at MAIN creates a master product.
select is(
  (select created from public.upsert_shopify_variant(
     :MAIN::uuid, 'sv-shared-main', 'Shared Honey', 'SHARED-1', 10.00)),
  true, 'new SKU at MAIN creates a master product');

-- The same SKU at EAST attaches to that SAME master (no duplicate parent).
select public.upsert_shopify_variant(
  :EAST::uuid, 'sv-shared-east', 'Shared Honey', 'SHARED-1', 11.00);
select is(
  (select count(distinct product_id)::int from child_skus where sku = 'SHARED-1'),
  1, 'same SKU across two sites shares one parent');
select is(
  (select count(*)::int from child_skus where sku = 'SHARED-1'),
  2, 'one child SKU per site under that parent');

-- Re-syncing EAST is idempotent (no new rows) and still updates price.
select public.upsert_shopify_variant(
  :EAST::uuid, 'sv-shared-east', 'Shared Honey 8oz', 'SHARED-1', 12.00);
select is(
  (select count(*)::int from child_skus where sku = 'SHARED-1'),
  2, 're-sync does not create a duplicate child');
select is(
  (select price from child_skus where store_variant_id = 'sv-shared-east'),
  12.00::numeric, 're-sync updates price in place');

-- A manually-entered SKU (no store variant yet) gets adopted, not duplicated.
insert into products(id, name)
  values ('77aa0000-0000-0000-0000-000000000001', 'Manual Bar');
insert into child_skus(product_id, site_id, sku, price, cost)
  values ('77aa0000-0000-0000-0000-000000000001', :MAIN, 'ADOPT-1', 5.00, 2.00);
select public.upsert_shopify_variant(
  :MAIN::uuid, 'sv-adopt', 'Manual Bar', 'ADOPT-1', 5.00);
select is(
  (select store_variant_id from child_skus where sku = 'ADOPT-1' and site_id = :MAIN),
  'sv-adopt', 'adopts the existing same-site SKU (binds the variant)');
select is(
  (select count(*)::int from child_skus where sku = 'ADOPT-1'),
  1, 'adoption did not create a duplicate child');

select * from finish();
rollback;
