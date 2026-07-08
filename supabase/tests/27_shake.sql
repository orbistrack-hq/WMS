-- Shake loss on the central pool (migration 0043).
-- record_shake debits the central pool as a loss + logs a 'shake' ledger row;
-- idempotent on the ref uuid; over-pool shake is blocked; reverse_shake restores.
begin;
select plan(9);

\set PROD '''33333333-0000-0000-0000-000000000001'''
\set REF  '''cafe0000-0000-0000-0000-000000000001'''

-- Intake 1 lb into the central pool.
select public.intake_receive(:PROD, 1, 'lb');
select is( (select on_hand_grams from parent_inventory where product_id=:PROD),
  448::numeric, 'central pool = 448 g after intake' );

-- Record 50 g of shake (a pure loss).
create temp table _sh on commit drop as
  select public.record_shake(:PROD, 50, :REF, null, 'LOT-9', 'floor sweep') as r;
select is( ((select r->>'shake_grams' from _sh))::numeric, 50::numeric,
  'record_shake reports 50 g lost' );
select is( (select on_hand_grams from parent_inventory where product_id=:PROD),
  398::numeric, 'pool debited to 398 g by the shake loss' );
select is(
  (select count(*)::int from parent_inventory_ledger where product_id=:PROD and reason='shake'),
  1, 'one shake ledger row written' );
select is(
  (select grams_lost from shake_report
     where ledger_id = ((select r->>'ledger_id' from _sh))::uuid),
  50::numeric, 'shake_report shows 50 g lost' );

-- Idempotent replay on the same ref.
select is( (select (public.record_shake(:PROD, 50, :REF))->>'replayed'), 'true',
  'same ref replays, no second debit' );
select is( (select on_hand_grams from parent_inventory where product_id=:PROD),
  398::numeric, 'replay did not double-debit the pool' );

-- Shake beyond the pool is blocked.
select throws_ok(
  $$ select public.record_shake('33333333-0000-0000-0000-000000000001', 100000,
       'cafe0000-0000-0000-0000-0000000000ff') $$,
  '23514', NULL, 'shake beyond the central pool is rejected' );

-- Reverse the 50 g shake (admin) -> pool restored.
insert into auth.users(id, email) values
  ('00000000-0000-0000-0000-0000000000a7','admin-a7@example.com');
update profiles set role='admin' where id='00000000-0000-0000-0000-0000000000a7';
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a7"}';
select public.reverse_shake(
  (select id from parent_inventory_ledger where reason='shake' and reference_id=:REF));
reset role;
select is( (select on_hand_grams from parent_inventory where product_id=:PROD),
  448::numeric, 'reverse_shake restores the pool to 448 g' );

select * from finish();
rollback;
