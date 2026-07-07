-- Client scoping (migration 0039): packaging types + merge_products.
--   * A client may add/edit packaging types only for a site it can access, and
--     never the shared (site_id NULL) defaults; it can't even see another site's
--     owned types.
--   * A client may merge duplicate masters entirely within its own site(s), but
--     is refused if ANY involved child (survivor OR loser) is at a site it can't
--     access. Operators still cross sites freely.
--   * The packaging stock writers now reject a site the caller can't access, and
--     reject stocking a site-owned type at the wrong site.
-- MAIN = 1111..., EAST = 2222... (from seed). Shared "Standard Box" = 1111..-01.
begin;
select plan(17);

\set MAIN '''11111111-1111-1111-1111-111111111111'''
\set EAST '''22222222-2222-2222-2222-222222222222'''
\set SHAREDBOX '''11111111-0000-0000-0000-000000000001'''
\set EASTPKG '''99999999-0000-0000-0000-0000000000e1'''
\set CLIENT '''00000000-0000-0000-0000-0000000000c1'''
\set OPER '''00000000-0000-0000-0000-0000000000d1'''
\set P1 '''d1000000-0000-0000-0000-0000000000a1'''
\set P2 '''d1000000-0000-0000-0000-0000000000b1'''
\set P3 '''d1000000-0000-0000-0000-0000000000c1'''
\set P4 '''d1000000-0000-0000-0000-0000000000d1'''
\set P5 '''d1000000-0000-0000-0000-0000000000e1'''
\set P6 '''d1000000-0000-0000-0000-0000000000f1'''

-- ---- setup (as superuser; bypasses RLS) ------------------------------------
insert into auth.users(id, email) values
  (:CLIENT, 'client-c1@example.com'),
  (:OPER,   'oper-d1@example.com');
update profiles set role='client'   where id=:CLIENT;
update profiles set role='operator' where id=:OPER;
insert into user_site_access(user_id, site_id) values (:CLIENT, :MAIN);

-- An EAST-owned packaging type the MAIN client must neither see nor stock.
insert into packaging_types(id, name, kind, unit_cost, site_id) values
  (:EASTPKG, 'East Only Box', 'box', 1.00, :EAST);

-- Merge fixtures. Weights are disjoint where a clean merge is expected.
insert into products(id, name) values
  (:P1, 'Client Strain'), (:P2, 'Client Strain'),
  (:P3, 'Cross Strain'),  (:P4, 'Cross Strain'),
  (:P5, 'Cross Strain 2'),(:P6, 'Cross Strain 2');
insert into child_skus(product_id, site_id, sku, price, grams_per_unit, variant_label) values
  (:P1, :MAIN, 'CS-P1-3_5', 10, 3.5, '3.5g'),
  (:P2, :MAIN, 'CS-P2-7',   11, 7,   '7g'),
  (:P3, :MAIN, 'CS-P3-3_5', 10, 3.5, '3.5g'),
  (:P4, :EAST, 'CS-P4-3_5', 10, 3.5, '3.5g'),
  (:P5, :EAST, 'CS-P5-7',   11, 7,   '7g'),
  (:P6, :MAIN, 'CS-P6-7',   11, 7,   '7g');

-- ============================================================================
-- Merge — as the MAIN client (SECURITY DEFINER reads auth.uid() from the JWT).
-- ============================================================================
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1"}';

select is(
  (public.merge_products(:P1, array[:P2]::uuid[], true)->>'ok'),
  'true', 'client: dry-run merge within its own site is allowed');
select is(
  (public.merge_products(:P1, array[:P2]::uuid[], true)->>'moved')::int,
  1, 'client: dry-run reports one child would move');
select is(
  (public.merge_products(:P1, array[:P2]::uuid[], false)->>'ok'),
  'true', 'client: merge within its own site commits');
select is(
  (select count(*)::int from child_skus where product_id = :P1),
  2, 'client: survivor now holds both weight children');
select is(
  (select is_active from products where id = :P2),
  false, 'client: emptied loser is deactivated');

select throws_ok(
  $$ select public.merge_products('d1000000-0000-0000-0000-0000000000c1',
       array['d1000000-0000-0000-0000-0000000000d1']::uuid[], false) $$,
  '42501', NULL,
  'client: merge blocked when a LOSER child is at an inaccessible site');
select throws_ok(
  $$ select public.merge_products('d1000000-0000-0000-0000-0000000000e1',
       array['d1000000-0000-0000-0000-0000000000f1']::uuid[], false) $$,
  '42501', NULL,
  'client: merge blocked when the SURVIVOR child is at an inaccessible site');

-- ---- packaging stock writers, still as the client --------------------------
select lives_ok(
  $$ select public.receive_packaging('11111111-0000-0000-0000-000000000001',
       '11111111-1111-1111-1111-111111111111', 10, 'client receipt') $$,
  'client: can receive a shared type at its own site');
select throws_ok(
  $$ select public.receive_packaging('11111111-0000-0000-0000-000000000001',
       '22222222-2222-2222-2222-222222222222', 10, 'nope') $$,
  '42501', NULL,
  'client: cannot receive stock at a site it cannot access');
select throws_ok(
  $$ select public.receive_packaging('99999999-0000-0000-0000-0000000000e1',
       '11111111-1111-1111-1111-111111111111', 10, 'nope') $$,
  '23514', NULL,
  'client: cannot stock another site''s owned type at its own site');

-- ============================================================================
-- Merge regression — an operator still crosses sites freely.
-- ============================================================================
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000d1"}';
select is(
  (public.merge_products(:P3, array[:P4]::uuid[], true)->>'ok'),
  'true', 'operator: can preview a cross-site merge');

-- ============================================================================
-- packaging_types RLS — evaluated as the real authenticated role.
-- ============================================================================
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1"}';

select is(
  (select count(*)::int from packaging_types where site_id is null),
  5, 'client: sees the five shared defaults');
select is(
  (select count(*)::int from packaging_types where id = :EASTPKG),
  0, 'client: cannot see another site''s owned type');

select lives_ok(
  $$ insert into packaging_types(id, name, kind, unit_cost, site_id)
     values ('99999999-0000-0000-0000-0000000000a1','My Jar','jar',0.30,
             '11111111-1111-1111-1111-111111111111') $$,
  'client: can add a type owned by its own site');
select throws_ok(
  $$ insert into packaging_types(name, kind, unit_cost, site_id)
     values ('Sneaky Shared','box',0.10, null) $$,
  '42501', NULL,
  'client: cannot add a shared (NULL-site) default');
select throws_ok(
  $$ insert into packaging_types(name, kind, unit_cost, site_id)
     values ('Sneaky East','box',0.10,'22222222-2222-2222-2222-222222222222') $$,
  '42501', NULL,
  'client: cannot add a type owned by another site');

-- A shared default is filtered out of the client's UPDATE by the RLS USING
-- clause, so the write silently affects zero rows and the value is unchanged.
update packaging_types set unit_cost = 99.99 where id = :SHAREDBOX;
select is(
  (select unit_cost from packaging_types where id = :SHAREDBOX)::numeric,
  0.85::numeric, 'client: cannot edit a shared default (unchanged)');

reset role;
select * from finish();
rollback;
