-- ============================================================================
-- Rollback for migration 0050: remove the `manager` role.
-- Any existing managers are downgraded to operator so the tighter CHECK holds.
-- ============================================================================

begin;

-- Downgrade managers before removing the value from the constraint.
update public.profiles set role = 'operator' where role = 'manager';

-- Restore is_operator() to admin+operator only.
create or replace function public.is_operator()
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(public.app_role() in ('admin', 'operator'), false);
$$;

-- Restore the original CHECK constraint.
alter table public.profiles drop constraint profiles_role_check;
alter table public.profiles
  add constraint profiles_role_check
  check (role in ('admin', 'operator', 'client'));

commit;
