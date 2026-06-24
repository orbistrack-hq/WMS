-- ============================================================================
-- WMS — Migration 0015: client self-serve Shopify integration
--
-- The dashboard is client-facing, so a store's integration must be managed by
-- the user who owns it — not by a WMS admin, and not via deployment env vars.
-- Two changes:
--
--   1. Re-scope shopify_connections / shopify_secrets / the import log from
--      admin-only to can_access_site(...). Operators see all sites; a client
--      sees only the sites assigned to them. So a client can connect their own
--      store and paste their own keys, scoped to their site.
--   2. Each store carries its own credentials: the Admin API access token (for
--      product sync) AND the app's API secret key (to verify that store's
--      webhook HMACs per-store, instead of one global env secret).
-- ============================================================================

begin;

-- 1. Per-store API secret (webhook HMAC). Both secrets optional now, since a
--    client may save them in steps.
alter table public.shopify_secrets
  add column if not exists api_secret text;
alter table public.shopify_secrets
  alter column access_token drop not null;

-- 2. Re-scope connections to site access (was admin-only).
drop policy if exists shopify_connections_read  on public.shopify_connections;
drop policy if exists shopify_connections_admin on public.shopify_connections;
create policy shopify_connections_rw on public.shopify_connections
  for all
  using (public.can_access_site(site_id))
  with check (public.can_access_site(site_id));

-- 3. Re-scope secrets to the parent connection's site (was admin-only).
drop policy if exists shopify_secrets_admin on public.shopify_secrets;
create policy shopify_secrets_rw on public.shopify_secrets
  for all
  using (exists (
    select 1 from public.shopify_connections c
     where c.id = connection_id and public.can_access_site(c.site_id)))
  with check (exists (
    select 1 from public.shopify_connections c
     where c.id = connection_id and public.can_access_site(c.site_id)));

-- 4. Import log: a client sees only imports for their own connected stores.
drop policy if exists shopify_order_imports_read on public.shopify_order_imports;
create policy shopify_order_imports_read on public.shopify_order_imports
  for select using (exists (
    select 1 from public.shopify_connections c
     where c.shop_domain = shop_domain and public.can_access_site(c.site_id)));

commit;
