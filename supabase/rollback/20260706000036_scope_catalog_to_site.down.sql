-- ============================================================================
-- Rollback 0036: restore the global products_read policy (Phase A behaviour)
-- ============================================================================
begin;

drop policy if exists products_read on public.products;
create policy products_read on public.products for select
  using (auth.uid() is not null);

commit;
