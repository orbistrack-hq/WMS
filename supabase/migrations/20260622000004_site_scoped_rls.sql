-- ============================================================================
-- WMS — Migration 0004: site-scoped row level security
--
-- Distinguishes two kinds of user:
--   * operator-side (admin, operator) — see and act across ALL sites
--   * client-side (client)            — see only the sites assigned to them
--
-- Phase A only ever creates admin/operator users, so behaviour is unchanged for
-- now. We build the scoping mechanism here, before production data exists, so
-- onboarding the first real client later is "insert user_site_access rows", not
-- a risky RLS rewrite on a live database.
--
-- Role storage moves from the user_role enum to a text column with a CHECK,
-- because the role set is now expected to grow and enum values are painful to
-- evolve. can_access_site(site_id) is the single predicate every site-bearing
-- policy filters on.
--
-- Scope of access:
--   site-bearing (site_id):           sites, child_skus, orders, fulfillment_groups
--   reached via a parent's site:      inventory_levels/ledger (child_sku),
--                                     order_line_items/billing_charges (order),
--                                     packaging_usage/shipments (group),
--                                     packages (shipment -> group)
--   global / shared (left as-is):     products, categories, customers,
--                                     packaging_types, fee_schedules, profiles,
--                                     audit_log
--   NOTE: products/categories/customers stay global for Phase A. Narrowing the
--   catalog and customer list per client is a refinement for the multi-client
--   phase, when client users actually exist.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. Role model: user_role enum -> text(admin|operator|client)
-- ----------------------------------------------------------------------------
-- app_role() must stop returning the enum first (return-type change => drop).
drop function if exists public.app_role();
create function public.app_role()
returns text language sql stable security definer set search_path = '' as $$
  select role::text from public.profiles where id = auth.uid();
$$;

alter table public.profiles alter column role drop default;
alter table public.profiles alter column role type text using role::text;
update public.profiles set role = 'operator' where role = 'staff';   -- our team
alter table public.profiles alter column role set default 'operator';
alter table public.profiles
  add constraint profiles_role_check check (role in ('admin','operator','client'));
drop type public.user_role;

-- ----------------------------------------------------------------------------
-- 2. Access helpers
-- ----------------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(public.app_role() = 'admin', false);
$$;

create or replace function public.is_operator()
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(public.app_role() in ('admin','operator'), false);
$$;

-- ----------------------------------------------------------------------------
-- 3. Site assignments (scopes client users)
-- ----------------------------------------------------------------------------
create table public.user_site_access (
  user_id    uuid not null references public.profiles(id) on delete cascade,
  site_id    uuid not null references public.sites(id)    on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, site_id)
);
alter table public.user_site_access enable row level security;
create policy usa_self_read   on public.user_site_access for select
  using (user_id = auth.uid() or public.is_admin());
create policy usa_admin_manage on public.user_site_access for all
  using (public.is_admin()) with check (public.is_admin());

-- The one predicate every site-bearing policy uses.
create or replace function public.can_access_site(p_site_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.is_operator()
      or exists (select 1 from public.user_site_access
                  where user_id = auth.uid() and site_id = p_site_id);
$$;

-- ----------------------------------------------------------------------------
-- 4. Drop the broad Phase-A policies on the tables we're about to scope.
-- ----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'child_skus','orders','fulfillment_groups','order_line_items',
    'inventory_levels','packaging_usage','shipments','packages','billing_charges'
  ] loop
    execute format('drop policy if exists %1$s_read   on public.%1$s;', t);
    execute format('drop policy if exists %1$s_write  on public.%1$s;', t);
    execute format('drop policy if exists %1$s_modify on public.%1$s;', t);
    execute format('drop policy if exists %1$s_delete on public.%1$s;', t);
  end loop;
end $$;
drop policy if exists sites_read on public.sites;
drop policy if exists sites_admin on public.sites;
drop policy if exists inventory_ledger_read   on public.inventory_ledger;
drop policy if exists inventory_ledger_insert on public.inventory_ledger;

-- ----------------------------------------------------------------------------
-- 5. Site-bearing tables (direct site_id): read/insert/update scoped, delete admin.
-- ----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['child_skus','orders','fulfillment_groups'] loop
    execute format('create policy %1$s_read   on public.%1$s for select using (public.can_access_site(site_id));', t);
    execute format('create policy %1$s_insert on public.%1$s for insert with check (public.can_access_site(site_id));', t);
    execute format('create policy %1$s_update on public.%1$s for update using (public.can_access_site(site_id)) with check (public.can_access_site(site_id));', t);
    execute format('create policy %1$s_delete on public.%1$s for delete using (public.is_admin());', t);
  end loop;
end $$;

-- sites itself: a user sees a site row if they can access that site.
create policy sites_read  on public.sites for select using (public.can_access_site(id));
create policy sites_admin on public.sites for all    using (public.is_admin()) with check (public.is_admin());

-- ----------------------------------------------------------------------------
-- 6. Tables reached via a parent's site.
-- ----------------------------------------------------------------------------
-- order_line_items -> orders.site_id
create policy order_line_items_read on public.order_line_items for select
  using (exists (select 1 from public.orders o where o.id = order_id and public.can_access_site(o.site_id)));
create policy order_line_items_insert on public.order_line_items for insert
  with check (exists (select 1 from public.orders o where o.id = order_id and public.can_access_site(o.site_id)));
create policy order_line_items_update on public.order_line_items for update
  using (exists (select 1 from public.orders o where o.id = order_id and public.can_access_site(o.site_id)))
  with check (exists (select 1 from public.orders o where o.id = order_id and public.can_access_site(o.site_id)));
create policy order_line_items_delete on public.order_line_items for delete using (public.is_admin());

-- billing_charges -> orders.site_id
create policy billing_charges_read on public.billing_charges for select
  using (exists (select 1 from public.orders o where o.id = order_id and public.can_access_site(o.site_id)));
create policy billing_charges_insert on public.billing_charges for insert
  with check (exists (select 1 from public.orders o where o.id = order_id and public.can_access_site(o.site_id)));
create policy billing_charges_update on public.billing_charges for update
  using (exists (select 1 from public.orders o where o.id = order_id and public.can_access_site(o.site_id)))
  with check (exists (select 1 from public.orders o where o.id = order_id and public.can_access_site(o.site_id)));
create policy billing_charges_delete on public.billing_charges for delete using (public.is_admin());

-- packaging_usage -> fulfillment_groups.site_id
create policy packaging_usage_read on public.packaging_usage for select
  using (exists (select 1 from public.fulfillment_groups g where g.id = group_id and public.can_access_site(g.site_id)));
create policy packaging_usage_insert on public.packaging_usage for insert
  with check (exists (select 1 from public.fulfillment_groups g where g.id = group_id and public.can_access_site(g.site_id)));
create policy packaging_usage_update on public.packaging_usage for update
  using (exists (select 1 from public.fulfillment_groups g where g.id = group_id and public.can_access_site(g.site_id)))
  with check (exists (select 1 from public.fulfillment_groups g where g.id = group_id and public.can_access_site(g.site_id)));
create policy packaging_usage_delete on public.packaging_usage for delete using (public.is_admin());

-- shipments -> fulfillment_groups.site_id
create policy shipments_read on public.shipments for select
  using (exists (select 1 from public.fulfillment_groups g where g.id = group_id and public.can_access_site(g.site_id)));
create policy shipments_insert on public.shipments for insert
  with check (exists (select 1 from public.fulfillment_groups g where g.id = group_id and public.can_access_site(g.site_id)));
create policy shipments_update on public.shipments for update
  using (exists (select 1 from public.fulfillment_groups g where g.id = group_id and public.can_access_site(g.site_id)))
  with check (exists (select 1 from public.fulfillment_groups g where g.id = group_id and public.can_access_site(g.site_id)));
create policy shipments_delete on public.shipments for delete using (public.is_admin());

-- packages -> shipments -> fulfillment_groups.site_id
create policy packages_read on public.packages for select
  using (exists (select 1 from public.shipments s join public.fulfillment_groups g on g.id = s.group_id
                 where s.id = shipment_id and public.can_access_site(g.site_id)));
create policy packages_insert on public.packages for insert
  with check (exists (select 1 from public.shipments s join public.fulfillment_groups g on g.id = s.group_id
                      where s.id = shipment_id and public.can_access_site(g.site_id)));
create policy packages_update on public.packages for update
  using (exists (select 1 from public.shipments s join public.fulfillment_groups g on g.id = s.group_id
                 where s.id = shipment_id and public.can_access_site(g.site_id)))
  with check (exists (select 1 from public.shipments s join public.fulfillment_groups g on g.id = s.group_id
                      where s.id = shipment_id and public.can_access_site(g.site_id)));
create policy packages_delete on public.packages for delete using (public.is_admin());

-- inventory_levels -> child_skus.site_id  (read only; writes are function-only since 0003)
create policy inventory_levels_read on public.inventory_levels for select
  using (exists (select 1 from public.child_skus cs where cs.id = child_sku_id and public.can_access_site(cs.site_id)));

-- inventory_ledger -> child_skus.site_id  (read only; writes are function-only since 0003)
create policy inventory_ledger_read on public.inventory_ledger for select
  using (exists (select 1 from public.child_skus cs where cs.id = child_sku_id and public.can_access_site(cs.site_id)));

commit;