-- ============================================================================
-- WMS — Migration 0051: managers (and admins) can manage categories
--
-- Category CRUD was locked to admins (categories_admin = is_admin, from the init
-- schema config-table pattern). Managing the category tree is part of a MANAGER's
-- duties, so this grants category writes to admin + manager. Operators are left
-- unchanged — they still cannot edit categories, exactly as today (floor roles do
-- picking/packing/receiving, not catalog taxonomy).
--
-- Note this is intentionally NARROWER than is_operator(): manager is otherwise
-- operator-level for data access, but category management is a manager/admin
-- capability that regular operators don't get. Hence a dedicated predicate rather
-- than reusing is_operator().
--
-- Read access is unchanged: categories_read still lets operators see the whole
-- tree and clients see only their visible categories.
--
-- Why a policy change is sufficient: the category server actions
-- (createCategory / renameCategory / reparentCategory / deleteCategory in
-- app/(app)/catalog/actions.ts) run on the USER client with no server-side role
-- check — they rely entirely on this RLS policy for authorization.
--
-- UI follow-up (app layer, not in this migration): catalog/categories/page.tsx
-- calls rpc('is_admin') to decide whether to render the edit controls. Swap that
-- to rpc('can_manage_categories') so managers get the editing UI too, and update
-- the "only an administrator" empty-state copy.
-- ============================================================================

begin;

-- Predicate: who may manage the category tree. Admins and managers, not the
-- broader operator tier. Mirrors the is_admin() / is_operator() helper style so
-- the UI can gate on it via rpc('can_manage_categories').
create or replace function public.can_manage_categories()
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(public.app_role() in ('admin', 'manager'), false);
$$;

-- Replace the admin-only write gate with the admin+manager one.
drop policy if exists categories_admin on public.categories;

create policy categories_write on public.categories
  for all
  using (public.can_manage_categories())
  with check (public.can_manage_categories());

commit;
