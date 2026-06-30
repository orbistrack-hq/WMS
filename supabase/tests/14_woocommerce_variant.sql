-- upsert_store_variant via the woocommerce channel: maps a variant and tags the
-- inventory movement with the channel (reference_type), idempotently.
begin;
select plan(4);
\set MAIN '''11111111-1111-1111-1111-111111111111'''

-- A new Woo variant (keyed by its store_variant_id) creates a product + child SKU.
select is(
  (select created from public.upsert_store_variant(
     '11111111-1111-1111-1111-111111111111'::uuid, 'woo-var-1', 'Woo Soap', 'WOO-1',
     6.50, null, 25, 'woocommerce')),
  true, 'woo upsert creates a child SKU');

-- Stock from Woo lands in on_hand.
select is(
  (select il.on_hand from inventory_levels il
     join child_skus cs on cs.id = il.child_sku_id
    where cs.store_variant_id = 'woo-var-1'),
  25, 'on_hand synced from Woo stock');

-- The movement is tagged with the woocommerce channel (not shopify).
select is(
  (select count(*)::int from inventory_ledger l
     join child_skus cs on cs.id = l.child_sku_id
    where cs.store_variant_id = 'woo-var-1' and l.reference_type = 'woocommerce'),
  1, 'inventory ledger row tagged reference_type = woocommerce');

-- Re-syncing the same quantity is a no-op (idempotent).
select public.upsert_store_variant(
  '11111111-1111-1111-1111-111111111111'::uuid, 'woo-var-1', 'Woo Soap', 'WOO-1',
  6.50, null, 25, 'woocommerce');
select is(
  (select count(*)::int from inventory_ledger l
     join child_skus cs on cs.id = l.child_sku_id
    where cs.store_variant_id = 'woo-var-1' and l.reference_type = 'woocommerce'),
  1, 're-sync with unchanged quantity adds no ledger row (idempotent)');

select * from finish();
rollback;
