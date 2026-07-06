-- ============================================================================
-- provision-warehouse-managers.sql — scope on-site managers to their 2 stores
-- ============================================================================
-- Stores in play (ONE channel per site — migration 0029 — so this is 2 sites):
--   • Shopify  "tsunami"   -> its own site
--   • Woo      "bud club"  -> its own site
--
-- Managers must see ONLY these two sites, so they are role = 'client'
-- (the scoped role) with a user_site_access row per site. 'operator' would
-- give them ALL sites — do NOT use it here.
--
-- ORDER OF OPERATIONS
--   1. (this script, part A) create the two sites if they don't exist.
--   2. Set up each store's integration yourself: app -> Integrations -> add
--      connection (Shopify tsunami / Woo bud club), pick the matching site,
--      paste credentials. Secrets are sealed to admin/service-role; managers
--      never see them.
--   3. Create each manager's auth account: Studio -> Authentication -> Add user
--      -> email + password (tick "Auto Confirm User" on hosted). The trigger
--      makes a profiles row at default 'operator'.
--   4. (this script, part B) flip each manager to 'client' and grant both sites.
--
-- Run in the Supabase SQL editor (service role). Idempotent. Edit the codes /
-- names in part A and the email in part B. Repeat part B per manager.
-- ============================================================================

begin;

-- ── PART A — the two sites already exist (codes TSU / BC). Sanity-check only. ─
do $$
begin
  if not exists (select 1 from public.sites where code = 'TSU') then
    raise exception 'No site with code TSU'; end if;
  if not exists (select 1 from public.sites where code = 'BC') then
    raise exception 'No site with code BC'; end if;
end $$;

-- ── PART B — scope ONE manager to both sites ────────────────────────────────
-- Change the email. Requires the auth account to exist already (step 3 above).
do $$
declare
  v_uid uuid;
  v_tsunami uuid;
  v_budclub uuid;
begin
  select id into v_uid from auth.users where email = 'MANAGER_EMAIL_HERE';
  if v_uid is null then
    raise exception 'No auth user MANAGER_EMAIL_HERE — create the account first (step 3).';
  end if;

  select id into v_tsunami from public.sites where code = 'TSU';
  select id into v_budclub from public.sites where code = 'BC';
  if v_tsunami is null or v_budclub is null then
    raise exception 'Sites not found — run PART A first.';
  end if;

  update public.profiles set role = 'client' where id = v_uid;

  insert into public.user_site_access (user_id, site_id)
  values (v_uid, v_tsunami), (v_uid, v_budclub)
  on conflict do nothing;

  raise notice 'Scoped % to Tsunami + Bud Club (client)', v_uid;
end $$;

commit;

-- ── Verify: each manager should show role=client and exactly their 2 sites ──
select u.email, p.role,
       coalesce(array_agg(s.name order by s.name)
                filter (where s.name is not null), '{}') as sites
from public.profiles p
join auth.users u on u.id = p.id
left join public.user_site_access usa on usa.user_id = p.id
left join public.sites s on s.id = usa.site_id
where u.email = 'MANAGER_EMAIL_HERE'
group by u.email, p.role;
