-- Shake pots by quality and distribution to brands (migration 0117).
-- A strain at MAIN and EAST is marked exotic; MAIN sells 90% of its grams and
-- EAST 10%. 1,000 g of exotic shake goes in the pot; the split must follow
-- those sales, block anything over a brand's share, land units on the brand
-- shake SKUs, show on Brand billing, and undo cleanly.
begin;
select plan(24);

\set MAIN   '''11111111-1111-1111-1111-111111111111'''
\set EAST   '''22222222-2222-2222-2222-222222222222'''
\set STRAIN '''33333333-0000-0000-0000-000000000001'''
\set SHAKE  '''5a4e0000-0000-0000-0000-000000000001'''
\set M28    '''5a4e0000-0000-0000-0000-0000000000a1'''
\set M14    '''5a4e0000-0000-0000-0000-0000000000a2'''
\set E28    '''5a4e0000-0000-0000-0000-0000000000b1'''
\set REF    '''5a4e0000-0000-0000-0000-0000000000f1'''

insert into auth.users(id,email) values
 ('00000000-0000-0000-0000-0000000117aa','shake-op@example.com'),
 ('00000000-0000-0000-0000-0000000117bb','shake-client@example.com');
update profiles set role='operator' where id='00000000-0000-0000-0000-0000000117aa';
update profiles set role='client'   where id='00000000-0000-0000-0000-0000000117bb';
insert into user_site_access(user_id,site_id)
 values ('00000000-0000-0000-0000-0000000117bb', :MAIN);

-- Strain variants are 3.5 g jars; a shake product with 28 g / 14 g at MAIN and
-- 28 g at EAST.
update child_skus set grams_per_unit = 3.5
 where id in ('a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000004');
insert into products(id, name) values (:SHAKE, 'Exotic Shake');
insert into child_skus(id, product_id, site_id, sku, grams_per_unit, variant_label) values
 (:M28, :SHAKE, :MAIN, 'MAIN-EX-SHAKE-28', 28, '28g'),
 (:M14, :SHAKE, :MAIN, 'MAIN-EX-SHAKE-14', 14, '14g'),
 (:E28, :SHAKE, :EAST, 'EAST-EX-SHAKE-28', 28, '28g');

-- Sales: MAIN 9 jars (31.5 g), EAST 1 jar (3.5 g), fulfilled Nov 2 Pacific.
create temp table o_m as select create_order(:MAIN::uuid,
  '[{"child_sku_id":"a0000000-0000-0000-0000-000000000001","quantity":9}]'::jsonb) as id;
create temp table o_e as select create_order(:EAST::uuid,
  '[{"child_sku_id":"a0000000-0000-0000-0000-000000000004","quantity":1}]'::jsonb) as id;
update orders set status='fulfilled', fulfilled_at='2026-11-02 12:00 America/Los_Angeles'
 where id in ((select id from o_m), (select id from o_e));

-- 1) A client cannot classify products.
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000117bb"}';
select throws_ok($$ select set_product_quality(array['33333333-0000-0000-0000-000000000001'::uuid], 'exotic') $$,
  '42501', NULL, 'client cannot set product quality');

set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000117aa"}';

-- 2) A shake product needs a quality first.
select throws_ok($$ select set_product_is_shake('5a4e0000-0000-0000-0000-000000000001', true) $$,
  '23514', NULL, 'cannot mark a shake product before it has a quality');

-- 3-4) Classify.
select is(set_product_quality(array[:STRAIN::uuid, :SHAKE::uuid], 'exotic'), 2,
  'set_product_quality updates both products');
select lives_ok($$ select set_product_is_shake('5a4e0000-0000-0000-0000-000000000001', true) $$,
  'shake product marked once it has a quality');

-- 5) Clearing a shake product's quality is blocked.
select throws_ok($$ select set_product_quality(array['5a4e0000-0000-0000-0000-000000000001'::uuid], null) $$,
  '23514', NULL, 'cannot clear the quality of a shake product');

-- 6-7) Shares come from sales: 90 / 10.
select is((select share from shake_brand_shares('exotic','2026-11-01','2026-11-05') where site_id=:MAIN),
  0.9::numeric, 'MAIN share is 90%');
select is((select share from shake_brand_shares('exotic','2026-11-01','2026-11-05') where site_id=:EAST),
  0.1::numeric, 'EAST share is 10%');

-- 8) Outside the period there are no sales to split by.
select is((select coalesce(sum(sold_grams),0) from shake_brand_shares('exotic','2026-10-01','2026-10-31')),
  0::numeric, 'no exotic sales in October');

-- 9-11) Add 1,000 g to the exotic pot, idempotent on ref.
select is((record_shake_in('exotic', 1000, :REF, 'opening bag'))->>'pot_grams', '1000.00',
  'pot holds 1,000 g');
select is((record_shake_in('exotic', 1000, :REF))->>'replayed', 'true', 'same ref replays');
select is((select on_hand_grams from shake_pots where quality='exotic'), 1000.00::numeric,
  'replay did not add twice');

-- 12-13) Preview targets: 900 g MAIN, 100 g EAST; MAIN lists its two sizes.
create temp table pv as select shake_distribution_preview('exotic','2026-11-01','2026-11-05') as j;
select is((select (b->>'target_grams')::numeric from pv, jsonb_array_elements(j->'brands') b
            where b->>'site_id' = '11111111-1111-1111-1111-111111111111'),
  900::numeric, 'MAIN target is 900 g');
select is((select jsonb_array_length(b->'variants') from pv, jsonb_array_elements(j->'brands') b
            where b->>'site_id' = '11111111-1111-1111-1111-111111111111'),
  2, 'MAIN preview lists its 28 g and 14 g shake SKUs');

-- 14) Over a brand's share is blocked (EAST 4 x 28 = 112 g > 100 g).
select throws_ok($$ select distribute_shake('exotic','2026-11-01','2026-11-05',
  '[{"child_sku_id":"5a4e0000-0000-0000-0000-0000000000b1","units":4}]'::jsonb) $$,
  '23514', NULL, 'EAST cannot take more than its 100 g share');

-- 15) A non-shake SKU is refused.
select throws_ok($$ select distribute_shake('exotic','2026-11-01','2026-11-05',
  '[{"child_sku_id":"a0000000-0000-0000-0000-000000000001","units":1}]'::jsonb) $$,
  '23514', NULL, 'a strain SKU cannot be filled from the shake pot');

-- 16) A period with no sales is refused.
select throws_ok($$ select distribute_shake('exotic','2026-10-01','2026-10-31',
  '[{"child_sku_id":"5a4e0000-0000-0000-0000-0000000000a1","units":1}]'::jsonb) $$,
  '23514', NULL, 'no sales in the period: nothing to split by');

-- 17-20) Distribute: MAIN 31 x 28 + 1 x 14 = 882 g, EAST 3 x 28 = 84 g.
create temp table d as select distribute_shake('exotic','2026-11-01','2026-11-05',
  '[{"child_sku_id":"5a4e0000-0000-0000-0000-0000000000a1","units":31},
    {"child_sku_id":"5a4e0000-0000-0000-0000-0000000000a2","units":1},
    {"child_sku_id":"5a4e0000-0000-0000-0000-0000000000b1","units":3}]'::jsonb,
  'dist-test-1') as j;
select is((select (j->>'total_grams')::numeric from d), 966::numeric, '966 g distributed');
select is((select on_hand_grams from shake_pots where quality='exotic'), 34.00::numeric,
  '34 g stays in the pot');
select is((select on_hand from inventory_levels where child_sku_id=:M28), 31,
  'MAIN 28 g shake SKU now has 31 units');
select is((select grams from shake_distribution_brands
            where distribution_id=((select j->>'distribution_id' from d))::uuid and site_id=:EAST),
  84.00::numeric, 'EAST received 84 g, recorded with its share');

-- 21) Brand billing shows the distributed shake for MAIN.
select is((select shake_grams from brand_billing_summary((now() at time zone 'America/Los_Angeles')::date, (now() at time zone 'America/Los_Angeles')::date) where site_id=:MAIN),
  882::numeric, 'Brand billing shows 882 g of shake for MAIN');

-- 22) The shake entry can't be undone once most of it was distributed.
select throws_ok($$ select reverse_shake_in((select id from shake_ledger where reason='shake_in'
  and reference_id='5a4e0000-0000-0000-0000-0000000000f1')) $$,
  '23514', NULL, 'cannot undo a shake entry that was already distributed');

-- 23) Undo the distribution: pot back to 1,000 g.
select lives_ok($$ select reverse_shake_distribution((select (j->>'distribution_id')::uuid from d)) $$,
  'distribution undone');
select is((select on_hand_grams from shake_pots where quality='exotic')
          + (select on_hand from inventory_levels where child_sku_id=:M28),
  1000.00::numeric, 'pot back to 1,000 g and MAIN 28 g SKU back to 0 units');

select * from finish();
rollback;
