-- Migration 0076: interim BOGO suspected-duplicate guard.
-- Proves:
--   * a normal coded SKU (price > 0, no twin) is NOT flagged;
--   * a stock-tracked give-away SKU (price 0 / cost > 0) IS flagged (fingerprint);
--   * a fee SKU (track_inventory = false, price 0 / cost > 0) is NOT flagged;
--   * inserting a dash-mangled twin flags the twin AND back-flags the original;
--   * the review view lists flagged rows and computes bogo_fingerprint correctly;
--   * _sku_norm strips punctuation and case.
-- MAIN site = 1111... (seeded by fixtures).
begin;
select plan(7);

\set MAIN '''11111111-1111-1111-1111-111111111111'''

insert into auth.users(id, email) values
  ('00000000-0000-0000-0000-0000000000d6', 'bogo-admin@example.com');
update profiles set role='admin' where id='00000000-0000-0000-0000-0000000000d6';
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000d6"}';

-- Parent products.
insert into products(id, name) values
  ('e1000000-0000-0000-0000-000000000001', 'Blue Slushie 3.5G'),
  ('e1000000-0000-0000-0000-000000000002', 'Give-Away Test'),
  ('e1000000-0000-0000-0000-000000000003', 'Fee Test');

-- 1. Normal coded, priced SKU — no twin yet, should NOT flag.
insert into child_skus(id, product_id, site_id, sku, price, cost) values
  ('e2000000-0000-0000-0000-000000000001',
   'e1000000-0000-0000-0000-000000000001', :MAIN, 'BC-BS-3.5G', 25.00, 8.00);
select is((select suspected_duplicate from child_skus
             where id='e2000000-0000-0000-0000-000000000001'), false,
  'normal priced SKU with no twin is not flagged');

-- 2. Give-away SKU: stock-tracked, price 0, cost > 0 — flagged by fingerprint.
insert into child_skus(id, product_id, site_id, sku, price, cost) values
  ('e2000000-0000-0000-0000-000000000002',
   'e1000000-0000-0000-0000-000000000002', :MAIN, 'GIVEAWAY-1', 0.00, 8.00);
select is((select suspected_duplicate from child_skus
             where id='e2000000-0000-0000-0000-000000000002'), true,
  'stock-tracked price 0 / cost > 0 SKU is flagged (BOGO fingerprint)');

-- 3. Fee SKU: price 0, cost > 0, but track_inventory = false — NOT flagged.
insert into child_skus(id, product_id, site_id, sku, price, cost, track_inventory) values
  ('e2000000-0000-0000-0000-000000000003',
   'e1000000-0000-0000-0000-000000000003', :MAIN, 'FEE-1', 0.00, 2.00, false);
select is((select suspected_duplicate from child_skus
             where id='e2000000-0000-0000-0000-000000000003'), false,
  'fee SKU (track_inventory=false) is not mistaken for BOGO');

-- 4. Dash-mangled twin of the normal SKU: flags the twin AND back-flags original.
insert into child_skus(id, product_id, site_id, sku, price, cost) values
  ('e2000000-0000-0000-0000-000000000004',
   'e1000000-0000-0000-0000-000000000001', :MAIN, 'BCBS-3.5G', 25.00, 8.00);
select is((select suspected_duplicate from child_skus
             where id='e2000000-0000-0000-0000-000000000004'), true,
  'dash-mangled twin is flagged on the collision');
select is((select suspected_duplicate from child_skus
             where id='e2000000-0000-0000-0000-000000000001'), true,
  'the pre-existing original is back-flagged when its twin appears');

-- 5. Review view: lists flagged rows, bogo_fingerprint correct.
select is((select bogo_fingerprint from suspected_duplicate_skus
             where id='e2000000-0000-0000-0000-000000000002'), true,
  'view marks the give-away row as bogo_fingerprint = true');

-- 6. Normalizer strips punctuation and case.
select is(public._sku_norm('bc-bs-3.5g'), 'BCBS35G',
  '_sku_norm strips punctuation and uppercases');

select * from finish();
rollback;
