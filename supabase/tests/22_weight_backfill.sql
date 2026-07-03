-- Weight-variant backfill (migration 0031): consolidate_weight_group.
-- Verifies admin gating, dry-run is a no-op, clean re-parenting + weight set,
-- emptied-parent deactivation, and collision skip+report (numbers differ).
begin;
select plan(13);

\set MAIN '''11111111-1111-1111-1111-111111111111'''
\set PA '''f0000000-0000-0000-0000-00000000000a'''
\set PD '''f0000000-0000-0000-0000-00000000000d'''

-- Flattened parents our sync would have produced, all at MAIN.
insert into products(id, name) values
  ('f0000000-0000-0000-0000-00000000000a', 'Foo - 3.5g'),
  ('f0000000-0000-0000-0000-00000000000b', 'Foo - 7g'),
  ('f0000000-0000-0000-0000-00000000000c', 'Foo - 28g'),
  ('f0000000-0000-0000-0000-00000000000d', 'Foo - 1oz');
insert into child_skus(product_id, site_id, sku, store_variant_id, price) values
  ('f0000000-0000-0000-0000-00000000000a', :MAIN, 'FOO-3_5', 'svA', 10),
  ('f0000000-0000-0000-0000-00000000000b', :MAIN, 'FOO-7',   'svB', 11),
  ('f0000000-0000-0000-0000-00000000000c', :MAIN, 'FOO-28',  'svC', 20),
  ('f0000000-0000-0000-0000-00000000000d', :MAIN, 'FOO-OZ',  'svD', 20);
select receive_stock((select id from child_skus where store_variant_id='svD'), 3);

\set MEMBERS '[{"product_id":"f0000000-0000-0000-0000-00000000000a","grams":3.5},{"product_id":"f0000000-0000-0000-0000-00000000000b","grams":7},{"product_id":"f0000000-0000-0000-0000-00000000000c","grams":28},{"product_id":"f0000000-0000-0000-0000-00000000000d","grams":28}]'

-- 1. Non-admin (no JWT) is rejected.
select throws_ok(
  $$ select consolidate_weight_group('Foo',
       '[{"product_id":"f0000000-0000-0000-0000-00000000000a","grams":3.5}]'::jsonb, true) $$,
  '42501', NULL, 'non-admin caller is rejected');

-- Become an admin for the rest.
insert into auth.users(id, email) values
  ('00000000-0000-0000-0000-0000000000ad', 'admin@example.com');
update profiles set role='admin' where id='00000000-0000-0000-0000-0000000000ad';
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000ad"}';

-- 2-4. Dry run: reports the plan, changes nothing.
create temp table dr on commit drop as
  select consolidate_weight_group('Foo', :'MEMBERS'::jsonb, true) as r;
select is(((select r->>'moved' from dr))::int, 3, 'dry run moves 3 (A,B,C; D collides)');
select is((select jsonb_array_length(r->'collisions') from dr), 1, 'dry run flags 1 collision');
select is((select product_id from child_skus where store_variant_id='svA'), :PA,
  'dry run leaves svA under its original parent');

-- 5-13. Apply.
create temp table ap on commit drop as
  select consolidate_weight_group('Foo', :'MEMBERS'::jsonb, false) as r;
select is(((select r->>'moved' from ap))::int, 3, 'apply moves 3 children');
select is(
  (select count(*)::int from products p
     where p.name='Foo'
       and exists (select 1 from child_skus c
                     where c.product_id=p.id and c.grams_per_unit is not null)),
  1, 'one canonical strain parent now holds weight children');
select is((select grams_per_unit from child_skus where store_variant_id='svA'), 3.5::numeric,
  'svA re-parented with grams 3.5');
select is((select grams_per_unit from child_skus where store_variant_id='svB'), 7::numeric,
  'svB re-parented with grams 7');
select is((select grams_per_unit from child_skus where store_variant_id='svC'), 28::numeric,
  'svC re-parented with grams 28');
select ok((select grams_per_unit from child_skus where store_variant_id='svD') is null,
  'svD (collision) is left un-moved');
select is((select product_id from child_skus where store_variant_id='svD'), :PD,
  'svD stays under its original parent for manual review');
select is(
  (select is_active from products where id='f0000000-0000-0000-0000-00000000000a'),
  false, 'emptied parent "Foo - 3.5g" is deactivated');
select is(
  (select is_active from products where id='f0000000-0000-0000-0000-00000000000d'),
  true, 'the parent still holding the collision child stays active');
select is(
  (select (r->'collisions'->0->>'on_hand') from ap), '3',
  'the collision reports the un-moved child on-hand (numbers differ)');

reset role;
select * from finish();
rollback;
