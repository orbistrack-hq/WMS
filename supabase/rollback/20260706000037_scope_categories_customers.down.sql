-- ============================================================================
-- Rollback 0037: restore global categories_read / customers_read (Phase A)
-- Drop the policies first (categories_read depends on the helper), then the fn.
-- ============================================================================
begin;

drop policy if exists customers_read on public.customers;
create policy customers_read on public.customers for select
  using (auth.uid() is not null);

drop policy if exists categories_read on public.categories;
create policy categories_read on public.categories for select
  using (auth.uid() is not null);

drop function if exists public.client_visible_category_ids();

commit;
