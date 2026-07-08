-- Central intake + allocation RPCs (migrations 0029 + 0042).
-- Covers: intake grams credit to the CENTRAL pool, delegation to child SKUs at
-- MULTIPLE sites from one central pool, the over-allocation guard, null-grams
-- rejection, allocation history, and idempotent replay.
begin;
select plan(17);

\set PROD1 '''33333333-0000-0000-0000-000000000001'''
\set PROD2 '''33333333-0000-0000-0000-000000000002'''
\set MAIN  '''11111111-1111-1111-1111-111111111111'''
\set EAST  '''22222222-2222-2222-2222-222222222222'''
\set B1 '''b0000000-0000-0000-0000-000000000001'''
\set B2 '''b0000000-0000-0000-0000-000000000002'''
\set B3 '''b0000000-0000-0000-0000-000000000003'''
\set B4 '''b0000000-0000-0000-0000-000000000004'''

-- Weight-variant child SKUs: PROD1 @ MAIN (3.5g, 7g), PROD1 @ EAST (3.5g, a
-- second "client"), and PROD2 @ MAIN (3.5g) for the idempotency case.
insert into child_skus (id, product_id, site_id, sku, grams_per_unit, variant_label) values
  ('b0000000-0000-0000-0000-000000000001', '33333333-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','WF-MAIN-3_5', 3.5,'3.5g'),
  ('b0000000-0000-0000-0000-000000000002', '33333333-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','WF-MAIN-7',   7,  '7g'),
  ('b0000000-0000-0000-0000-000000000003', '33333333-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222','WF-EAST-3_5', 3.5,'3.5g'),
  ('b0000000-0000-0000-0000-000000000004', '33333333-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','CL-MAIN-3_5', 3.5,'3.5g');

-- ---- intake (central: no receiving site) ----------------------------------
create temp table _in on commit drop as
  select public.intake_receive(:PROD1, 1, 'lb', 'LOT-A', 'first pound') as r;
select is( ((select r->>'on_hand_grams' from _in))::numeric, 448::numeric,
  'intake of 1 lb credits 448 g to the central pool' );
select is(
  (select on_hand_grams from parent_inventory where product_id=:PROD1),
  448::numeric, 'central parent_inventory on_hand = 448 g after intake' );
select is(
  (select count(*)::int from parent_inventory_ledger
     where product_id=:PROD1 and reason='intake'),
  1, 'one intake ledger row written' );

-- ---- allocation (one central pool -> children at two sites) ----------------
-- MAIN 3.5g x16 = 56, MAIN 7g x8 = 56, EAST 3.5g x8 = 28  => total 140 g.
create temp table _al on commit drop as
  select public.allocate_parent_stock(
    :PROD1,
    '[{"child_sku_id":"b0000000-0000-0000-0000-000000000001","units":16},
      {"child_sku_id":"b0000000-0000-0000-0000-000000000002","units":8},
      {"child_sku_id":"b0000000-0000-0000-0000-000000000003","units":8}]'::jsonb,
    null, 'spread across two clients') as r;

select is( ((select r->>'total_grams' from _al))::numeric, 140::numeric,
  'allocation totals 140 g' );
select is( ((select r->>'remaining_grams' from _al))::numeric, 308::numeric,
  'result reports 308 g remaining' );
select is( ((select r->>'child_count' from _al))::int, 3,
  'three child SKUs allocated' );
select is(
  (select on_hand_grams from parent_inventory where product_id=:PROD1),
  308::numeric, 'central pool debited to 308 g' );
select is(
  (select allocated_grams from parent_inventory where product_id=:PROD1),
  140::numeric, 'allocated_grams counter = 140 g' );
select is( (select on_hand from inventory_levels where child_sku_id=:B1), 16,
  'MAIN 3.5g child credited 16 units' );
select is( (select on_hand from inventory_levels where child_sku_id=:B2), 8,
  'MAIN 7g child credited 8 units' );
select is( (select on_hand from inventory_levels where child_sku_id=:B3), 8,
  'EAST 3.5g child credited 8 units (cross-site, one central pool)' );
select is(
  (select count(*)::int from allocation_lines
     where allocation_id = ((select r->>'allocation_id' from _al))::uuid),
  3, 'three allocation_lines recorded' );

-- ---- over-allocation guard ------------------------------------------------
select throws_ok(
  $$ select allocate_parent_stock(
       '33333333-0000-0000-0000-000000000001',
       '[{"child_sku_id":"b0000000-0000-0000-0000-000000000001","units":100000}]'::jsonb) $$,
  '23514', NULL, 'allocation beyond parent available is rejected' );

-- ---- a child with no grams_per_unit cannot be allocated -------------------
select throws_ok(
  $$ select allocate_parent_stock(
       '33333333-0000-0000-0000-000000000001',
       '[{"child_sku_id":"a0000000-0000-0000-0000-000000000001","units":1}]'::jsonb) $$,
  NULL, NULL, 'a child SKU without grams_per_unit is rejected' );

-- ---- idempotent replay (separate central pool) ----------------------------
select public.intake_receive(:PROD2, 100, 'g');
create temp table _id1 on commit drop as
  select public.allocate_parent_stock(
    :PROD2,
    '[{"child_sku_id":"b0000000-0000-0000-0000-000000000004","units":10}]'::jsonb,
    'IDEM-1', null) as r;
select is( ((select r->>'remaining_grams' from _id1))::numeric, 65::numeric,
  'first allocation leaves 65 g (100 - 10x3.5)' );

create temp table _id2 on commit drop as
  select public.allocate_parent_stock(
    :PROD2,
    '[{"child_sku_id":"b0000000-0000-0000-0000-000000000004","units":10}]'::jsonb,
    'IDEM-1', null) as r;
select is( (select r->>'replayed' from _id2), 'true',
  'replaying the same idempotency key is flagged as a replay' );
select is(
  (select on_hand_grams from parent_inventory where product_id=:PROD2),
  65::numeric, 'replay does not debit the pool a second time' );

select * from finish();
rollback;
