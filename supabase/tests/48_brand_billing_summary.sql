-- brand_billing_summary (migration 0112): the Brand billing page's one call.
-- Checks it against the same roll-up computed independently from the base
-- tables (what the page used to do client-side), plus the specific cases the
-- page's warnings depend on: Pacific month edges, open groups, manual-channel
-- packaging gaps, fulfilled orders with no pick fee, p_site, RLS, and (0114)
-- per-brand shake grams.
-- Uses seeded SKUs at MAIN (a0..01) and EAST (a0..04) and seeded packaging.
begin;
select plan(13);

-- Since 0113 the summary is security definer and scopes itself to the
-- caller's sites, so it needs a caller: an operator, set up front. (The
-- reference roll-up below still reads the tables directly as the superuser.)
insert into auth.users(id,email) values
 ('00000000-0000-0000-0000-0000000112aa','summary-op@example.com'),
 ('00000000-0000-0000-0000-0000000112bb','summary-client@example.com');
update profiles set role='operator' where id='00000000-0000-0000-0000-0000000112aa';
update profiles set role='client'   where id='00000000-0000-0000-0000-0000000112bb';
insert into user_site_access(user_id,site_id)
 values ('00000000-0000-0000-0000-0000000112bb', '22222222-2222-2222-2222-222222222222');

-- 12) No caller, no rows — definer must not leak to an unidentified session.
select is(
  (select count(*)::int from brand_billing_summary('2026-01-01', '2026-12-31')),
  0,
  'no JWT caller: returns nothing');

set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000112aa"}';
\set BOX   '''11111111-0000-0000-0000-000000000001'''
\set LABEL '''11111111-0000-0000-0000-000000000002'''
\set MAIN  '''11111111-1111-1111-1111-111111111111'''
\set EAST  '''22222222-2222-2222-2222-222222222222'''

-- A) MAIN Woo, 2 units, box + label, fulfilled 23:30 Pacific Sep 30 — billable
--    in September with a pick fee (fulfill_order snapshots it).
create temp table o_a as select create_order(:MAIN::uuid,
  '[{"child_sku_id":"a0000000-0000-0000-0000-000000000001","quantity":2}]'::jsonb,
  p_channel => 'woocommerce') as id;
select record_packaging_usage((select group_id from orders where id=(select id from o_a)), :BOX, 1);
select record_packaging_usage((select group_id from orders where id=(select id from o_a)), :LABEL, 1);
select fulfill_order((select id from o_a));
update orders set fulfilled_at = '2026-09-30 23:30 America/Los_Angeles' where id=(select id from o_a);
update fulfillment_groups set fulfilled_at = '2026-09-30 23:30 America/Los_Angeles'
 where id=(select group_id from orders where id=(select id from o_a));

-- B) MAIN manual, marked fulfilled Sep 12 WITHOUT fulfill_order: no packaging
--    (a manual-channel gap) and no pick fee (a missing fee).
create temp table o_b as select create_order(:MAIN::uuid,
  '[{"child_sku_id":"a0000000-0000-0000-0000-000000000001","quantity":1}]'::jsonb,
  p_channel => 'manual') as id;
update orders set status='fulfilled', fulfilled_at='2026-09-12 10:00 America/Los_Angeles'
 where id=(select id from o_b);
update fulfillment_groups set status='fulfilled', fulfilled_at='2026-09-12 10:00 America/Los_Angeles'
 where id=(select group_id from orders where id=(select id from o_b));

-- C) EAST Woo, 3 units, fulfilled 00:30 Pacific Oct 1 — October, not September.
create temp table o_c as select create_order(:EAST::uuid,
  '[{"child_sku_id":"a0000000-0000-0000-0000-000000000004","quantity":3}]'::jsonb,
  p_channel => 'woocommerce') as id;
select record_packaging_usage((select group_id from orders where id=(select id from o_c)), :BOX, 1);
select fulfill_order((select id from o_c));
update orders set fulfilled_at = '2026-10-01 00:30 America/Los_Angeles' where id=(select id from o_c);
update fulfillment_groups set fulfilled_at = '2026-10-01 00:30 America/Los_Angeles'
 where id=(select group_id from orders where id=(select id from o_c));

-- D) EAST open order created Sep 15 — counted as open, never billed.
create temp table o_d as select create_order(:EAST::uuid,
  '[{"child_sku_id":"a0000000-0000-0000-0000-000000000004","quantity":1}]'::jsonb) as id;
update fulfillment_groups set created_at = '2026-09-15 12:00 America/Los_Angeles'
 where id=(select group_id from orders where id=(select id from o_d));

-- 1-2) Matches an independent roll-up from the base tables, both months.
create temp table ref as
with m(p_from, p_to) as (values ('2026-09-01'::date, '2026-09-30'::date),
                                ('2026-10-01'::date, '2026-10-31'::date)),
pk as (
  select m.p_from, c.site_id, sum(c.packaging_cost) as packaging, count(*) as groups
  from m join storefront_fulfillment_cost c
    on c.billing_date between m.p_from and m.p_to and c.group_status = 'fulfilled'
  group by m.p_from, c.site_id),
fe as (
  select m.p_from, o.site_id, count(*) as orders, sum(bc.amount) as pick_fees,
         sum((select sum(quantity) from order_line_items li where li.order_id = o.id)) as units
  from m join orders o
    on (o.fulfilled_at at time zone 'America/Los_Angeles')::date between m.p_from and m.p_to
   and o.status <> 'cancelled'
  join billing_charges bc on bc.order_id = o.id and bc.fee_type = 'pick_fee'
  group by m.p_from, o.site_id)
select coalesce(pk.p_from, fe.p_from) as p_from, coalesce(pk.site_id, fe.site_id) as site_id,
       coalesce(pk.groups, 0)::bigint as groups, coalesce(pk.packaging, 0) as packaging,
       coalesce(fe.orders, 0)::bigint as orders, coalesce(fe.units, 0)::bigint as units,
       coalesce(fe.pick_fees, 0) as pick_fees
from pk full join fe on fe.p_from = pk.p_from and fe.site_id = pk.site_id;

select results_eq(
  $$ select site_id, fulfilled_groups, packaging, orders, units, pick_fees
       from brand_billing_summary('2026-09-01', '2026-09-30')
      where fulfilled_groups > 0 or orders > 0 order by site_id $$,
  $$ select site_id, groups, packaging, orders, units, pick_fees
       from ref where p_from = '2026-09-01' order by site_id $$,
  'September matches the independent roll-up');
select results_eq(
  $$ select site_id, fulfilled_groups, packaging, orders, units, pick_fees
       from brand_billing_summary('2026-10-01', '2026-10-31')
      where fulfilled_groups > 0 or orders > 0 order by site_id $$,
  $$ select site_id, groups, packaging, orders, units, pick_fees
       from ref where p_from = '2026-10-01' order by site_id $$,
  'October matches the independent roll-up');

-- 3) MAIN September: both groups, A's packaging, A's pick fee and units only.
select results_eq(
  $$ select fulfilled_groups, packaging, orders, units
       from brand_billing_summary('2026-09-01', '2026-09-30') where site_id = '11111111-1111-1111-1111-111111111111' $$,
  $$ values (2::bigint, 0.97::numeric, 1::bigint, 2::bigint) $$,
  'MAIN September: 2 groups, $0.97 packaging, 1 charged order, 2 units');

-- 4) B is a manual-channel packaging gap, not a store gap.
select results_eq(
  $$ select store_gap_groups, manual_gap_groups
       from brand_billing_summary('2026-09-01', '2026-09-30') where site_id = '11111111-1111-1111-1111-111111111111' $$,
  $$ values (0::bigint, 1::bigint) $$,
  'manual-channel gap counted separately from store gaps');

-- 5) B is listed as missing a pick fee, with its order number.
select is(
  (select (missing_fee_order_ids, missing_fee_order_numbers)::text
     from brand_billing_summary('2026-09-01', '2026-09-30') where site_id = '11111111-1111-1111-1111-111111111111'),
  (select (array[id], array[order_number])::text from orders where id = (select id from o_b)),
  'fulfilled order with no pick fee is returned for backfill');

-- 6) EAST in September: only the open group — no billing, but disclosed.
select results_eq(
  $$ select fulfilled_groups, open_groups, orders
       from brand_billing_summary('2026-09-01', '2026-09-30') where site_id = '22222222-2222-2222-2222-222222222222' $$,
  $$ values (0::bigint, 1::bigint, 0::bigint) $$,
  'EAST September: one open group, nothing billable');

-- 7) EAST in October: C with its 3 units.
select results_eq(
  $$ select fulfilled_groups, orders, units
       from brand_billing_summary('2026-10-01', '2026-10-31') where site_id = '22222222-2222-2222-2222-222222222222' $$,
  $$ values (1::bigint, 1::bigint, 3::bigint) $$,
  'EAST October: early-Oct-1 order lands in October');

-- 8) p_site.
select is(
  (select array_agg(site_id) from brand_billing_summary('2026-09-01', '2026-09-30', :MAIN::uuid)),
  array[:MAIN::uuid],
  'p_site returns only that site');

-- 13) Shake per brand (0114): MAIN's tagged, non-reversed September shake only.
--     Excluded: a reversed entry, an untagged (pre-0114) entry, and one at
--     00:30 Pacific Oct 1, which belongs to October.
insert into parent_inventory_ledger(product_id, site_id, delta_grams, reason, reference_type, created_at, reversed_at)
select cs.product_id, v.site_id, v.delta, 'shake', 'shake', v.at, v.rev
from child_skus cs,
 (values (:MAIN::uuid, -5.00, '2026-09-10 12:00 America/Los_Angeles'::timestamptz, null::timestamptz),
         (:MAIN::uuid, -1.50, '2026-09-30 23:00 America/Los_Angeles', null),
         (:MAIN::uuid, -3.00, '2026-09-11 12:00 America/Los_Angeles', now()),
         (null::uuid,  -2.00, '2026-09-12 12:00 America/Los_Angeles', null),
         (:MAIN::uuid, -4.00, '2026-10-01 00:30 America/Los_Angeles', null))
   as v(site_id, delta, at, rev)
where cs.id = 'a0000000-0000-0000-0000-000000000001';
select results_eq(
  $$ select site_id, shake_grams from brand_billing_summary('2026-09-01', '2026-09-30') order by site_id $$,
  $$ values (:MAIN::uuid, 6.50::numeric), (:EAST::uuid, 0::numeric) $$,
  'shake: MAIN September is 6.5 g (tagged, not reversed, in period); EAST none');

-- Under the app role.
create temp table su as
  select site_id, packaging, orders, units, pick_fees
  from brand_billing_summary('2026-09-01', '2026-09-30');
grant select on su to authenticated;

set local role authenticated;

-- 9) Operator gets exactly what the superuser got.
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000112aa"}';
select results_eq(
  $$ select site_id, packaging, orders, units, pick_fees
       from brand_billing_summary('2026-09-01', '2026-09-30') order by site_id $$,
  $$ select * from su order by site_id $$,
  'operator (authenticated) sees the same summary');

-- 10) EAST-only client sees nothing of MAIN...
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000112bb"}';
select ok(
  not exists(select 1 from brand_billing_summary('2026-09-01', '2026-09-30')
              where site_id = :MAIN::uuid),
  'RLS: EAST-only client sees no MAIN row');

-- 11) ...but does see its own.
select ok(
  exists(select 1 from brand_billing_summary('2026-09-01', '2026-09-30')
          where site_id = :EAST::uuid),
  'RLS: EAST-only client sees its own row');

reset role;
select * from finish();
rollback;
