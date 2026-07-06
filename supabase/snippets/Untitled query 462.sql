-- ============================================================================
-- provision-user.sql — set a user's role (and site access) in OrbisTrack
-- ============================================================================
-- Role model (migration 0004):
--   admin     full admin; drives is_admin() policies
--   operator  internal team; sees ALL sites (the default for a new signup)
--   client    external; sees only the sites listed in user_site_access
--
-- This script assigns roles to auth users that ALREADY EXIST. Create the auth
-- user first — either Studio -> Authentication -> Add user (email + password,
-- mark confirmed), or the app's /auth/sign-up page. The handle_new_user trigger
-- creates the matching public.profiles row automatically (default role operator).
--
-- Run in the Supabase SQL editor (service role). Edit the :email / :site values.
-- Everything is idempotent and wrapped so a bad email fails loudly, not silently.
-- ============================================================================

begin;

-- ── 1. Promote an ADMIN ─────────────────────────────────────────────────────
-- Replace the email. Errors if no such auth user exists.
do $$
declare v_uid uuid;
begin
  select id into v_uid from auth.users where email = 'demo123@mail.com';
  if v_uid is null then
    raise exception 'No auth user with that email — create the account first.';
  end if;
  update public.profiles set role = 'admin' where id = v_uid;
  raise notice 'Set % to admin', v_uid;
end $$;

-- ── 2. OPERATOR (internal team, all sites) ─────────────────────────────────
-- New signups are already 'operator', so this is only needed to (re)assert it.
-- update public.profiles set role = 'operator'
--   where id = (select id from auth.users where email = 'demo123@gmail.com');

-- ── 3. CLIENT (external, scoped to specific sites) ─────────────────────────
-- Sets the role AND grants one or more sites. Look up site ids first:
--   select id, name from public.sites order by name;
-- do $$
-- declare v_uid uuid;
-- begin
--   select id into v_uid from auth.users where email = 'demo123@gmail.com';
--   if v_uid is null then raise exception 'Create the account first.'; end if;
--   update public.profiles set role = 'client' where id = v_uid;
--   insert into public.user_site_access (user_id, site_id)
--   values (v_uid, '<site-uuid>')            -- repeat / add rows per site
--   on conflict do nothing;
-- end $$;

commit;

-- ── Verify everyone ─────────────────────────────────────────────────────────
select u.email, p.role,
       coalesce(array_agg(usa.site_id) filter (where usa.site_id is not null), '{}') as sites
from public.profiles p
join auth.users u on u.id = p.id
left join public.user_site_access usa on usa.user_id = p.id
group by u.email, p.role
order by p.role, u.email;
