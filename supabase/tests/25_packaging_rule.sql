-- Editable weight→packaging rule (migration 0040): the singleton config row.
--   * exactly one row, seeded at the in-code default (3.5g);
--   * the singleton guard + check constraint hold;
--   * an ADMIN may change the threshold; a CLIENT may not (RLS), and everyone
--     signed in may read it.
begin;
select plan(7);

\set ADMIN  '''00000000-0000-0000-0000-0000000000a9'''
\set CLIENT '''00000000-0000-0000-0000-0000000000c9'''

-- ---- setup (as superuser; bypasses RLS) ------------------------------------
insert into auth.users(id, email) values
  (:ADMIN,  'admin-a9@example.com'),
  (:CLIENT, 'client-c9@example.com');
update profiles set role='admin'  where id=:ADMIN;
update profiles set role='client' where id=:CLIENT;

-- Seeded exactly once, at the default threshold.
select is((select count(*) from packaging_rule), 1::bigint,
  'exactly one rule row is seeded');
select is((select jar_max_grams from packaging_rule), 3.5::numeric(8,2),
  'default threshold is 3.5g');

-- Singleton guard: a second row is refused (unique on the always-true column).
select throws_ok(
  $$ insert into packaging_rule default values $$,
  '23505', null, 'singleton: a second rule row is rejected');

-- Threshold must be positive.
select throws_ok(
  $$ update packaging_rule set jar_max_grams = 0 $$,
  '23514', null, 'threshold must be greater than zero');

-- ---- as an ADMIN: may change the threshold ---------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a9"}';
select lives_ok(
  $$ update packaging_rule set jar_max_grams = 5 $$,
  'admin: can update the threshold');
reset role;
select is((select jar_max_grams from packaging_rule), 5::numeric(8,2),
  'admin update took effect');

-- ---- as a CLIENT: RLS blocks the write (0 rows), value unchanged -----------
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c9"}';
update packaging_rule set jar_max_grams = 9;
reset role;
select is((select jar_max_grams from packaging_rule), 5::numeric(8,2),
  'client: cannot change the threshold (unchanged)');

select * from finish();
rollback;
