-- Site-scoped RLS: operator sees all sites; client sees only assigned sites.
-- Runs as the real 'authenticated' role with simulated JWT claims, exactly as
-- Supabase evaluates policies in production.
begin;
select plan(4);

-- two users: operator (all sites) and client (assigned MAIN only)
insert into auth.users(id,email) values
 ('00000000-0000-0000-0000-0000000000aa','op@example.com'),
 ('00000000-0000-0000-0000-0000000000bb','client@example.com');
update profiles set role='operator' where id='00000000-0000-0000-0000-0000000000aa';
update profiles set role='client'   where id='00000000-0000-0000-0000-0000000000bb';
insert into user_site_access(user_id,site_id)
 values ('00000000-0000-0000-0000-0000000000bb','11111111-1111-1111-1111-111111111111');

set local role authenticated;

-- client: only the one assigned site, only its SKUs
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000bb"}';
select is((select count(*)::int from sites), 1, 'client sees only its assigned site');
select is((select count(*)::int from child_skus), 3, 'client sees only MAIN SKUs (3 of 4)');

-- operator: all sites and all SKUs
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000aa"}';
select is((select count(*)::int from sites), 2, 'operator sees both sites');
select is((select count(*)::int from child_skus), 4, 'operator sees all SKUs');

reset role;
select * from finish();
rollback;
