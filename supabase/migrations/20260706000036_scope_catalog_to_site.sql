-- ============================================================================
-- Migration 0036: scope the parent CATALOG (products) to the client's sites
-- ----------------------------------------------------------------------------
-- Phase A left products/categories/customers GLOBAL (migration 0004 header),
-- so a `client` user sees every parent product even though child_skus are
-- already site-scoped — i.e. they can see other stores' catalog.
--
-- Fix: a client may read a product only if that product has at least one
-- child_sku at a site they can access. Operators/admins keep seeing ALL
-- products (including brand-new parents with no children yet) via the
-- is_operator() short-circuit, so nothing changes for the internal team.
--
-- can_access_site() / is_operator() are SECURITY DEFINER, so the subquery
-- reads child_skus + user_site_access regardless of the caller's RLS.
-- Index support: child_skus_product_site_variant_key (product_id, site_id, …)
-- from migration 0028 already covers the (product_id, site_id) lookup.
--
-- Scope of THIS migration: products (select) only — the reported leak.
-- categories/customers scoping is intentionally NOT included here; see the
-- note at the end. Reverse with rollback/20260706000036_*.down.sql.
-- ============================================================================

begin;

drop policy if exists products_read on public.products;
create policy products_read on public.products for select using (
  public.is_operator()
  or exists (
    select 1 from public.child_skus cs
    where cs.product_id = products.id
      and public.can_access_site(cs.site_id)
  )
);

commit;

-- Note (not changed here, flagged for a follow-up decision):
--   • categories_read and customers_read are still `auth.uid() is not null`
--     (global). A client can still see category names and the full customer
--     list. Scoping categories needs an ancestor-aware rule (tree render);
--     scoping customers means "customers with an order at my site". Decide
--     whether to include these before the client role goes live.
--   • Verify parent-rollup VIEWS (inventory_report, /inventory/by-parent) are
--     security_invoker so they don't bypass this policy for a client.
