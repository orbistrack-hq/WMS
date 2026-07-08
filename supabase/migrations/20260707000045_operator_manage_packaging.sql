-- ============================================================================
-- WMS — Migration 0045: operators manage shared packaging config (FB-7)
--
-- Migration 0039 made SHARED packaging defaults (packaging_types.site_id IS
-- NULL) editable by admins only, to stop one client editing global defaults in
-- a multi-tenant database. The deployment model has since changed to ONE
-- Supabase per client, so that isolation reason is gone and the admin-only gate
-- just blocks the internal ops team (operators) from managing packaging — the
-- "can't edit even on an admin account" report.
--
-- This opens shared-packaging management (and the jar/bag threshold from 0040)
-- to admin OR operator via is_operator(). Site-OWNED types are unchanged (still
-- managed by anyone who can access that site). Reads are unchanged.
--
-- Reverse with rollback/20260707000045_operator_manage_packaging.down.sql.
-- ============================================================================

begin;

-- packaging_types: shared branch now is_operator() (was is_admin()).
drop policy if exists packaging_types_insert on public.packaging_types;
drop policy if exists packaging_types_update on public.packaging_types;
drop policy if exists packaging_types_delete on public.packaging_types;

create policy packaging_types_insert on public.packaging_types for insert
  with check (
    public.is_operator()
    or (site_id is not null and public.can_access_site(site_id))
  );
create policy packaging_types_update on public.packaging_types for update
  using (
    public.is_operator()
    or (site_id is not null and public.can_access_site(site_id))
  )
  with check (
    public.is_operator()
    or (site_id is not null and public.can_access_site(site_id))
  );
create policy packaging_types_delete on public.packaging_types for delete
  using (
    public.is_operator()
    or (site_id is not null and public.can_access_site(site_id))
  );

-- packaging_rule (jar/bag threshold, migration 0040): operators may edit it too.
drop policy if exists packaging_rule_admin on public.packaging_rule;
create policy packaging_rule_manage on public.packaging_rule for all
  using (public.is_operator()) with check (public.is_operator());

commit;
