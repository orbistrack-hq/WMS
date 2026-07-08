-- Central parent bulk inventory + allocation schema (migrations 0028 + 0042).
-- Covers: UoM conversion, child weight-variant uniqueness, the CENTRAL parent
-- level primitives + ledger, and the non-negative on_hand guard.
-- The parent pool is now per-product (no site); child SKUs remain per-site.
-- Uses seeded product 33333333-...0001 (Wildflower Honey).
begin;
select plan(18);

\set PROD '''33333333-0000-0000-0000-000000000001'''

-- ---- UoM conversion -------------------------------------------------------
select is( to_grams(1,  'lb'),  448::numeric, '1 lb  = 448 g' );
select is( to_grams(1,  'oz'),  28::numeric,  '1 oz  = 28 g'  );
select is( to_grams(16, 'g'),   16::numeric,  '16 g  = 16 g'  );
select is( to_grams(1,  'kg'),  1000::numeric,'1 kg  = 1000 g');
select throws_ok( $$ select to_grams(1, 'furlong') $$, '23514', NULL,
  'unsupported UoM is rejected' );

-- ---- child weight-variant uniqueness (still per product+site) --------------
select lives_ok(
  $$ insert into child_skus (product_id, site_id, sku, grams_per_unit, variant_label)
     values ('33333333-0000-0000-0000-000000000001',
             '11111111-1111-1111-1111-111111111111','WF-3_5G', 3.5, '3.5g') $$,
  'first 3.5g weight variant inserts' );
select lives_ok(
  $$ insert into child_skus (product_id, site_id, sku, grams_per_unit, variant_label)
     values ('33333333-0000-0000-0000-000000000001',
             '11111111-1111-1111-1111-111111111111','WF-7G', 7, '7g') $$,
  'second weight variant (7g) coexists at same product+site' );
select throws_ok(
  $$ insert into child_skus (product_id, site_id, sku, grams_per_unit)
     values ('33333333-0000-0000-0000-000000000001',
             '11111111-1111-1111-1111-111111111111','WF-3_5G-DUP', 3.5) $$,
  '23505', NULL, 'duplicate 3.5g variant at same product+site is rejected' );
select throws_ok(
  $$ insert into child_skus (product_id, site_id, sku)
     values ('33333333-0000-0000-0000-000000000001',
             '11111111-1111-1111-1111-111111111111','WF-SECOND-NULL') $$,
  '23505', NULL, 'second non-weight child at same product+site is rejected' );

-- ---- central parent inventory primitives -----------------------------------
select lives_ok(
  $$ select _parent_inv_lock('33333333-0000-0000-0000-000000000001') $$,
  '_parent_inv_lock materializes a zero central row on demand' );
select is(
  (select on_hand_grams from parent_inventory where product_id=:PROD),
  0::numeric, 'new central parent level starts at 0 g' );

select lives_ok(
  $$ select _parent_inv_write('33333333-0000-0000-0000-000000000001', 448, 0,
       'intake','manual',null,'LOT-1','test intake') $$,
  'intake credits 448 g' );
select is(
  (select on_hand_grams from parent_inventory where product_id=:PROD),
  448::numeric, 'central parent on_hand = 448 g after intake' );
select is(
  (select count(*)::int from parent_inventory_ledger
     where product_id=:PROD and reason='intake'),
  1, 'one intake ledger row written' );

-- allocation-style debit: remove 56 g, bump allocated for reporting.
select lives_ok(
  $$ select _parent_inv_write('33333333-0000-0000-0000-000000000001', -56, 56,
       'allocation','allocation',null,null,'test alloc') $$,
  'allocation debit of 56 g succeeds' );
select is(
  (select on_hand_grams from parent_inventory where product_id=:PROD),
  392::numeric, 'central parent on_hand = 392 g after 56 g allocated' );
select is(
  (select allocated_grams from parent_inventory where product_id=:PROD),
  56::numeric, 'allocated_grams = 56 g (reporting counter)' );

-- non-negative guard: cannot debit more than on hand.
select throws_ok(
  $$ select _parent_inv_write('33333333-0000-0000-0000-000000000001', -500, 500,
       'allocation','allocation',null,null,'over') $$,
  '23514', NULL, 'debit below zero on_hand is rejected' );

select * from finish();
rollback;
