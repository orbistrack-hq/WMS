-- Rollback for migration 0065: restore admin-only delete on packaging_usage.
-- Policy-only change, no data touched — fully reversible.
begin;

drop policy if exists packaging_usage_delete on public.packaging_usage;
create policy packaging_usage_delete on public.packaging_usage
  for delete using (public.is_admin());

commit;
