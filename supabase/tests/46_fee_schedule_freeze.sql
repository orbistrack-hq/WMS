-- Migration 0090: a pick-fee rate that has billed an order is frozen.
--
-- This is the invariant that makes the Settings rate editor safe. If a schedule
-- row could be edited or deleted after it had billed, changing the rate would
-- silently re-price closed months (the billing report re-reads charges, and the
-- backfill path re-resolves by fulfilment date). The guard is a trigger, not a
-- policy, so it holds for service-role writes that bypass RLS too.
--
-- Uses seeded SKU WF-HONEY-MAIN (a0000000-...0001) at seeded site MAIN
-- (11111111-...1111) and the seeded 2020-01-01 fee schedule.
begin;
select plan(6);
\set SKU '''a0000000-0000-0000-0000-000000000001'''
\set A '''11111111-1111-1111-1111-111111111111'''

insert into orders(id, site_id) values ('99000000-2222-0000-0000-000000000001', :A);
insert into order_line_items(order_id, child_sku_id, quantity, unit_price)
  values ('99000000-2222-0000-0000-000000000001', :SKU, 2, 12);
select charge_order_pick_fee('99000000-2222-0000-0000-000000000001');

select isnt(
  (select fee_schedule_id from billing_charges
    where order_id = '99000000-2222-0000-0000-000000000001' and fee_type = 'pick_fee'),
  null, 'the charge snapshotted which schedule billed it');

-- 1. A schedule that has billed cannot be re-rated.
select throws_ok(
  $$update fee_schedules set first_unit_rate = 9.99 where effective_from = date '2020-01-01'$$,
  'P0001', null,
  'a schedule that has billed cannot be edited');

-- 2. ...nor deleted.
select throws_ok(
  $$delete from fee_schedules where effective_from = date '2020-01-01'$$,
  'P0001', null,
  'a schedule that has billed cannot be deleted');

-- 3. The already-billed amount is untouched by the attempts above.
select is(
  (select amount from billing_charges
    where order_id = '99000000-2222-0000-0000-000000000001' and fee_type = 'pick_fee'),
  1.50::numeric, 'the billed amount is unchanged (1.25 + 1*0.25)');

-- 4. A queued rate that has billed nothing stays editable, so a rate published
--    for next month can still be corrected or cancelled.
insert into fee_schedules(id, effective_from, first_unit_rate, additional_unit_rate)
  values ('99000000-3333-0000-0000-000000000001', current_date + 30, 1.50, 0.30);
update fee_schedules set first_unit_rate = 1.60
  where id = '99000000-3333-0000-0000-000000000001';
select is(
  (select first_unit_rate from fee_schedules where id = '99000000-3333-0000-0000-000000000001'),
  1.60::numeric, 'an unused future rate is still editable');

-- 5. Two rates cannot start on the same day — resolve_fee_schedule() picks
--    "latest effective_from" and would be nondeterministic if they could.
select throws_ok(
  $$insert into fee_schedules(effective_from, first_unit_rate, additional_unit_rate)
    values (date '2020-01-01', 2.00, 0.50)$$,
  '23505', null,
  'two rates cannot start on the same day');

select * from finish();
rollback;
