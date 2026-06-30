-- upsert_store_variant: create then idempotent update, keyed by store_variant_id.
begin;
select plan(8);
\set MAIN '''11111111-1111-1111-1111-111111111111'''

-- first call creates a product + child SKU
select is(
  (select created from public.upsert_store_variant(
     '11111111-1111-1111-1111-111111111111'::uuid, 'shopvar-999', 'Lavender Honey', 'LAV-HONEY', 14.00)),
  true, 'first upsert creates');
select is((select count(*)::int from child_skus where site_id=:MAIN and store_variant_id='shopvar-999'),
  1, 'one child SKU for the variant');
select is((select price from child_skus where store_variant_id='shopvar-999'), 14.00::numeric,
  'price set from Shopify');
select is((select name from products p join child_skus cs on cs.product_id=p.id
            where cs.store_variant_id='shopvar-999'), 'Lavender Honey', 'product name set');

-- second call updates in place (no duplicate), new price, preserves cost
select is(
  (select created from public.upsert_store_variant(
     '11111111-1111-1111-1111-111111111111'::uuid, 'shopvar-999', 'Lavender Honey 8oz', 'LAV-HONEY', 15.50)),
  false, 'second upsert updates in place');
select is((select count(*)::int from child_skus where site_id=:MAIN and store_variant_id='shopvar-999'),
  1, 'still one child SKU (idempotent)');
select is((select price from child_skus where store_variant_id='shopvar-999'), 15.50::numeric,
  'price updated');
select is((select cost from child_skus where store_variant_id='shopvar-999'), 0::numeric,
  'cost preserved (WMS-owned)');

select * from finish();
rollback;
