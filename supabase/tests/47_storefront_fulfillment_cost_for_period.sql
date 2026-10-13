-- storefront_fulfillment_cost_for_period (migration 0111): the period-bounded
-- replacement the Brand billing page reads. It must return exactly what the
-- 0030 view returns for the same period, put Pacific month boundaries in the
-- right month, honour p_site, and work under the app's authenticated role.
-- Uses seeded SKUs at MAIN (a0..01) and EAST (a0..04) and the seeded Standard
-- Box / Shipping Label packaging types.
begin;
select plan(9);
\set BOX   '''11111111-0000-0000-0000-000000000001'''
\set LABEL '''11111111-0000-0000-0000-000000000002'''
\set MAIN  '''11111111-1111-1111-1111-111111111111'''
\set EAST  '''22222222-2222-2222-2222-222222222222'''

-- Last-evening-of-September (Pacific) fulfilled Woo order at MAIN, packed.
create temp table o_late as select create_order(:MAIN::uuid,
  '[{"child_sku_id":"a0000000-0000-0000-0000-000000000001","quantity":2}]'::jsonb,
  p_channel => 'woocommerce') as id;
select record_packaging_usage((select group_id from orders where id=(select id from o_late)), :BOX, 1);
select record_packaging_usage((select group_id from orders where id=(select id from o_late)), :LABEL, 1);
select fulfill_order((select id from o_late));
update fulfillment_groups set fulfilled_at = '2026-09-30 23:30 America/Los_Angeles'
 where id = (select group_id from orders where id=(select id from o_late));

-- First-minutes-of-October (Pacific) — 07:30 UTC on Oct 1, so a UTC date cast
-- would wrongly call this September.
create temp table o_oct as select create_order(:MAIN::uuid,
  '[{"child_sku_id":"a0000000-0000-0000-0000-000000000001","quantity":1}]'::jsonb,
  p_channel => 'woocommerce') as id;
select record_packaging_usage((select group_id from orders where id=(select id from o_oct)), :BOX, 1);
select fulfill_order((select id from o_oct));
update fulfillment_groups set fulfilled_at = '2026-10-01 00:30 America/Los_Angeles'
 where id = (select group_id from orders where id=(select id from o_oct));

-- Still-open manual order at EAST: no fulfilled_at, so billing_date falls back
-- to created_at.
create temp table o_open as select create_order(:EAST::uuid,
  '[{"child_sku_id":"a0000000-0000-0000-0000-000000000004","quantity":1}]'::jsonb,
  p_channel => 'manual') as id;
update fulfillment_groups set created_at = '2026-09-15 12:00 America/Los_Angeles'
 where id = (select group_id from orders where id=(select id from o_open));

-- Cancelled group in September — excluded by both.
create temp table o_cancel as select create_order(:EAST::uuid,
  '[{"child_sku_id":"a0000000-0000-0000-0000-000000000004","quantity":1}]'::jsonb) as id;
update fulfillment_groups set status = 'cancelled', created_at = '2026-09-10 12:00 America/Los_Angeles'
 where id = (select group_id from orders where id=(select id from o_cancel));

-- 1) Identical to the view for September, every column.
select results_eq(
  $$ select * from storefront_fulfillment_cost_for_period('2026-09-01', '2026-09-30')
     order by group_id $$,
  $$ select * from storefront_fulfillment_cost
      where billing_date between '2026-09-01' and '2026-09-30'
     order by group_id $$,
  'September matches the view row for row');

-- 2) Identical to the view for October.
select results_eq(
  $$ select * from storefront_fulfillment_cost_for_period('2026-10-01', '2026-10-31')
     order by group_id $$,
  $$ select * from storefront_fulfillment_cost
      where billing_date between '2026-10-01' and '2026-10-31'
     order by group_id $$,
  'October matches the view row for row');

-- 3) 23:30 Pacific on Sep 30 lands in September with its packaging.
select is(
  (select packaging_cost from storefront_fulfillment_cost_for_period('2026-09-01', '2026-09-30')
    where group_id = (select group_id from orders where id=(select id from o_late))),
  0.97::numeric,
  'late Sep 30 group is in September with box + label packaging');

-- 4) 00:30 Pacific on Oct 1 is NOT in September...
select ok(
  not exists(select 1 from storefront_fulfillment_cost_for_period('2026-09-01', '2026-09-30')
              where group_id = (select group_id from orders where id=(select id from o_oct))),
  'early Oct 1 group is not in September');

-- 5) ...it is in October.
select ok(
  exists(select 1 from storefront_fulfillment_cost_for_period('2026-10-01', '2026-10-31')
          where group_id = (select group_id from orders where id=(select id from o_oct))),
  'early Oct 1 group is in October');

-- 6) Open group is included by created_at, and cancelled is not.
select is(
  (select array_agg(group_status order by group_status)
     from storefront_fulfillment_cost_for_period('2026-09-01', '2026-09-30', :EAST::uuid)),
  array['open'],
  'p_site=EAST returns only its open group; cancelled excluded');

-- 7) p_site keeps other sites out.
select ok(
  not exists(select 1 from storefront_fulfillment_cost_for_period('2026-09-01', '2026-09-30', :MAIN::uuid)
              where site_id <> :MAIN::uuid),
  'p_site=MAIN returns only MAIN rows');

-- Under the app role, with RLS.
insert into auth.users(id,email) values
 ('00000000-0000-0000-0000-0000000111aa','billing-op@example.com'),
 ('00000000-0000-0000-0000-0000000111bb','billing-client@example.com');
update profiles set role='operator' where id='00000000-0000-0000-0000-0000000111aa';
update profiles set role='client'   where id='00000000-0000-0000-0000-0000000111bb';
insert into user_site_access(user_id,site_id)
 values ('00000000-0000-0000-0000-0000000111bb', :EAST::uuid);

set local role authenticated;

-- 8) Operator sees the same September rows as the superuser view read.
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000111aa"}';
select is(
  (select count(*)::int from storefront_fulfillment_cost_for_period('2026-09-01', '2026-09-30')),
  2,
  'operator (authenticated) can call it and sees both September groups');

-- 9) Client assigned EAST only cannot see MAIN's group through the function.
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000111bb"}';
select ok(
  not exists(select 1 from storefront_fulfillment_cost_for_period('2026-09-01', '2026-09-30')
              where site_id = :MAIN::uuid),
  'RLS still applies: EAST-only client sees no MAIN rows');

reset role;
select * from finish();
rollback;
