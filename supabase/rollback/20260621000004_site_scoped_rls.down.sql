-- ============================================================================
-- WMS — Migration 0004: DOWN (reverses 0004_site_scoped_rls.up.sql)
-- Restores the broad Phase-A policies and the admin/staff enum.
-- Assumes no 'client' users exist yet (they map back to 'staff').
-- ============================================================================

begin;

-- 1. Drop the site-scoped policies.
do $$
declare t text;
begin
  foreach t in array array[
    'child_skus','orders','fulfillment_groups','order_line_items',
    'inventory_levels','packaging_usage','shipments','packages','billing_charges'
  ] loop
    execute format('drop policy if exists %1$s_read   on public.%1$s;', t);
    execute format('drop policy if exists %1$s_insert on public.%1$s;', t);
    execute format('drop policy if exists %1$s_update on public.%1$s;', t);
    execute format('drop policy if exists %1$s_delete on public.%1$s;', t);
  end loop;
end $$;
drop policy if exists sites_read  on public.sites;
drop policy if exists sites_admin on public.sites;
drop policy if exists inventory_ledger_read on public.inventory_ledger;

-- 2. Drop scoping objects.
drop function if exists public.can_access_site(uuid);
drop function if exists public.is_operator();
drop table if exists public.user_site_access;

-- 3. Role storage text -> user_role enum (operator/client collapse back to staff).
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles alter column role drop default;
update public.profiles set role = 'staff' where role in ('operator','client');
create type public.user_role as enum ('admin','staff');
alter table public.profiles alter column role type public.user_role using role::public.user_role;
alter table public.profiles alter column role set default 'staff';

drop function if exists public.app_role();
create function public.app_role()
returns public.user_role language sql stable security definer as $$
  select role from public.profiles where id = auth.uid();
$$;
create or replace function public.is_admin()
returns boolean language sql stable as $$
  select coalesce(public.app_role() = 'admin', false);
$$;

-- 4. Restore the broad Phase-A policies.
create policy sites_read  on public.sites for select using (auth.uid() is not null);
create policy sites_admin on public.sites for all    using (public.is_admin()) with check (public.is_admin());

do $$
declare t text;
begin
  foreach t in array array[
    'child_skus','fulfillment_groups','orders','order_line_items',
    'packaging_usage','shipments','packages','billing_charges'
  ] loop
    execute format('create policy %1$s_read   on public.%1$s for select using (auth.uid() is not null);', t);
    execute format('create policy %1$s_write  on public.%1$s for insert with check (auth.uid() is not null);', t);
    execute format('create policy %1$s_modify on public.%1$s for update using (auth.uid() is not null) with check (auth.uid() is not null);', t);
    execute format('create policy %1$s_delete on public.%1$s for delete using (public.is_admin());', t);
  end loop;
end $$;

create policy inventory_levels_read on public.inventory_levels for select using (auth.uid() is not null);
create policy inventory_ledger_read on public.inventory_ledger for select using (auth.uid() is not null);

commit;
