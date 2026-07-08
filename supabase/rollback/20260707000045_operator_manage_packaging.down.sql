-- ============================================================================
-- Rollback 0045: restore admin-only management of shared packaging config.
-- Reverts packaging_types shared-branch policies + the packaging_rule write
-- policy to their is_admin() (0039 / 0040) forms.
-- ============================================================================

begin;

drop policy if exists packaging_types_insert on public.packaging_types;
drop policy if exists packaging_types_update on public.packaging_types;
drop policy if exists packaging_types_delete on public.packaging_types;

create policy packaging_types_insert on public.packaging_types for insert
  with check (
    public.is_admin()
    or (site_id is not null and public.can_access_site(site_id))
  );
create policy packaging_types_update on public.packaging_types for update
  using (
    public.is_admin()
    or (site_id is not null and public.can_access_site(site_id))
  )
  with check (
    public.is_admin()
    or (site_id is not null and public.can_access_site(site_id))
  );
create policy packaging_types_delete on public.packaging_types for delete
  using (
    public.is_admin()
    or (site_id is not null and public.can_access_site(site_id))
  );

drop policy if exists packaging_rule_manage on public.packaging_rule;
create policy packaging_rule_admin on public.packaging_rule for all
  using (public.is_admin()) with check (public.is_admin());

commit;
