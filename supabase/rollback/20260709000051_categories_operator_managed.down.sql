-- ============================================================================
-- Rollback for migration 0051: restore admin-only category writes.
-- ============================================================================

begin;

drop policy if exists categories_write on public.categories;

create policy categories_admin on public.categories
  for all
  using (public.is_admin())
  with check (public.is_admin());

drop function if exists public.can_manage_categories();

commit;
