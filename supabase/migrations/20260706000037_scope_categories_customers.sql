-- ============================================================================
-- Migration 0037: scope CATEGORIES and CUSTOMERS to the client's sites
-- ----------------------------------------------------------------------------
-- Follows 0036 (which scoped products). Phase A left these two tables global;
-- a `client` (site-scoped) user could still see every store's category tree and
-- the full cross-store customer list. Operators/admins are unaffected via the
-- is_operator() short-circuit.
--
-- Write paths are already safe (so the 0036 RETURNING gotcha does not recur):
--   • customers are inserted only by the service-role order-import path
--     (lib/{shopify,woocommerce}/import-orders.ts) — RLS bypassed.
--   • categories are written by admins only (categories_admin = is_admin).
--   • create_order is INVOKER but takes an existing customer_id and inserts no
--     customer; orders carry site_id directly, so their RETURNING already
--     passes for the owning site.
--   NOTE: if manual customer creation via the user client is ever added, route
--   it through the service role (like imports) or it will hit the same
--   childless-parent RETURNING rejection.
--
-- Reverse with rollback/20260706000037_scope_categories_customers.down.sql.
-- ============================================================================

begin;

-- ── Customers: visible if the client has an order for them at an allowed site ─
drop policy if exists customers_read on public.customers;
create policy customers_read on public.customers for select using (
  public.is_operator()
  or exists (
    select 1 from public.orders o
    where o.customer_id = customers.id
      and public.can_access_site(o.site_id)
  )
);

-- ── Categories: the set of categories that (directly) hold a product the
--    client can see, plus every ancestor so the adjacency tree renders from
--    the root. SECURITY DEFINER so it reads products/child_skus/categories
--    past RLS; can_access_site() applies the caller's own scope. ─────────────
create or replace function public.client_visible_category_ids()
returns setof uuid
language sql stable security definer set search_path = '' as $$
  with recursive base as (
    select distinct p.category_id as id
    from public.products p
    join public.child_skus cs on cs.product_id = p.id
    where p.category_id is not null
      and public.can_access_site(cs.site_id)
  ),
  anc as (
    select id from base
    union
    select c.parent_id
    from public.categories c
    join anc on anc.id = c.id
    where c.parent_id is not null
  )
  select id from anc;
$$;

drop policy if exists categories_read on public.categories;
create policy categories_read on public.categories for select using (
  public.is_operator()
  or id in (select public.client_visible_category_ids())
);

commit;
