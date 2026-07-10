-- ============================================================================
-- provision-ddot-admin.sql — give ddot44890@gmail.com an ADMIN login
-- ============================================================================
-- Two steps. This file is STEP 2. Do STEP 1 first (create the auth user),
-- otherwise this script raises 'create the account first' and changes nothing.
--
-- STEP 1 — create the auth account (pick ONE):
--   • Hosted:  Studio -> Authentication -> Add user -> email + password,
--              tick "Auto Confirm User". (Prod has email confirmation on.)
--   • Local:   Studio at http://127.0.0.1:54323 -> Authentication -> Add user
--              (local has enable_confirmations = false, so no email step), OR
--              just sign up at /auth/sign-up in the running app.
--   Either way the handle_new_user trigger auto-creates the public.profiles row
--   at the default role 'operator'. STEP 2 promotes it to 'admin'.
--
-- STEP 2 — run this in the Supabase SQL editor (service role). Idempotent.
-- Role model (migration 0004): admin = full | operator = internal, all sites
-- | client = external, per-site. For internal testing, 'admin' gives full reach.
-- ============================================================================

begin;

do $$
declare v_uid uuid;
begin
  select id into v_uid from auth.users where email = 'ddot44890@gmail.com';
  if v_uid is null then
    raise exception 'No auth user ddot44890@gmail.com — do STEP 1 (create the account) first.';
  end if;
  update public.profiles set role = 'admin' where id = v_uid;
  raise notice 'Promoted % (ddot44890@gmail.com) to admin', v_uid;
end $$;

commit;

-- ── Verify ──────────────────────────────────────────────────────────────────
select u.email, p.role
from public.profiles p
join auth.users u on u.id = p.id
where u.email = 'ddot44890@gmail.com';
-- Expect one row: ddot44890@gmail.com | admin
