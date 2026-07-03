-- Forward weight-variant sync (migration 0030): upsert_store_weight_variant.
-- Covers strain-parent creation, cross-client grouping by name, idempotent
-- re-sync, and inventory pull.
begin;
select plan(11);

\set MAIN '''11111111-1111-1111-1111-111111111111'''
\set EAST '''22222222-2222-2222-2222-222222222222'''

-- First weight variant of a new strain: creates the parent + 3.5g child.
select lives_ok(
  $$ select upsert_store_weight_variant(
       '11111111-1111-1111-1111-111111111111','sv-af-3_5','Apple Fritter',3.5,
       'AF-3.5',12,null,null,'shopify') $$,
  'first weight variant inserts');
select is(
  (select grams_per_unit from child_skus
     where store_variant_id='sv-af-3_5' and site_id=:MAIN),
  3.5::numeric, 'child carries grams_per_unit 3.5');
select is(
  (select variant_label from child_skus
     where store_variant_id='sv-af-3_5' and site_id=:MAIN),
  '3.5g', 'child variant_label = 3.5g');
select is(
  (select count(*)::int from products p
     where p.name='Apple Fritter'
       and exists (select 1 from child_skus c
                     where c.product_id=p.id and c.grams_per_unit is not null)),
  1, 'exactly one strain parent created');

-- Second weight of the same strain, same store -> same parent.
select lives_ok(
  $$ select upsert_store_weight_variant(
       '11111111-1111-1111-1111-111111111111','sv-af-7','Apple Fritter',7,
       'AF-7',11,null,null,'shopify') $$,
  '7g variant inserts');
select is(
  (select product_id from child_skus where store_variant_id='sv-af-7' and site_id=:MAIN),
  (select product_id from child_skus where store_variant_id='sv-af-3_5' and site_id=:MAIN),
  '3.5g and 7g share one strain parent');

-- Same strain at ANOTHER client store -> still the same parent (cross-client).
select lives_ok(
  $$ select upsert_store_weight_variant(
       '22222222-2222-2222-2222-222222222222','sv-af-3_5-e','Apple Fritter',3.5,
       'AF-3.5',12,null,null,'shopify') $$,
  'cross-store 3.5g at EAST inserts');
select is(
  (select product_id from child_skus where store_variant_id='sv-af-3_5-e' and site_id=:EAST),
  (select product_id from child_skus where store_variant_id='sv-af-3_5' and site_id=:MAIN),
  'EAST child shares the same strain parent (cross-client grouping)');

-- Re-sync the same variant with stock -> updates in place, no duplicate.
select lives_ok(
  $$ select upsert_store_weight_variant(
       '11111111-1111-1111-1111-111111111111','sv-af-3_5','Apple Fritter',3.5,
       'AF-3.5',13,null,10,'shopify') $$,
  're-syncing the same variant succeeds');
select is(
  (select count(*)::int from child_skus
     where store_variant_id='sv-af-3_5' and site_id=:MAIN),
  1, 're-sync does not duplicate the child');
select is(
  (select il.on_hand from inventory_levels il
     join child_skus c on c.id = il.child_sku_id
    where c.store_variant_id='sv-af-3_5' and c.site_id=:MAIN),
  10, 'inventory quantity synced to on_hand');

select * from finish();
rollback;
