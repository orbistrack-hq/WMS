-- ============================================================================
-- WMS — Migration 0018: lock down shopify_secrets
--
-- shopify_secrets holds the Admin API access_token (full store control) and the
-- webhook api_secret (lets anyone forge signed webhooks). Migration 0015 made
-- the row readable by anyone who can_access_site, and migration 0011's blanket
-- "grant select on all tables to authenticated" means the raw values are
-- reachable through the public Data API with a normal logged-in session — not
-- just from trusted server code. That is the exposure we close here.
--
-- After this migration:
--   * authenticated has NO table privileges on shopify_secrets, and no RLS
--     policy grants it access — the table is unreachable via PostgREST.
--   * The webhook (service_role) and the server actions (service-role admin
--     client) still read/write it; service_role bypasses RLS and grants.
--   * The UI reads a boolean-only view (has_token / has_secret), scoped per
--     caller, so it can show setup status without ever seeing a secret value.
--
-- Encrypting the values at rest (Supabase Vault) is a sensible follow-up; this
-- migration shuts the access-control hole, which is the urgent part.
-- ============================================================================

begin;

-- 1. Remove the site-scoped read/write policy and all table privileges from the
--    API role. With RLS enabled and no policy, authenticated is default-denied
--    even if a future grant slips back in.
drop policy if exists shopify_secrets_rw on public.shopify_secrets;
revoke select, insert, update, delete on public.shopify_secrets from authenticated;

-- 2. Boolean-only status view. A plain (owner-privileged) view, so it can read
--    the now-sealed table, but it only ever returns booleans — never a secret.
--    Rows are scoped to the caller via can_access_site, matching prior behaviour.
create or replace view public.shopify_credential_status as
select c.id as connection_id,
       (s.access_token is not null and length(btrim(s.access_token)) > 0) as has_token,
       (s.api_secret  is not null and length(btrim(s.api_secret))  > 0) as has_secret
  from public.shopify_connections c
  left join public.shopify_secrets s on s.connection_id = c.id
 where public.can_access_site(c.site_id);

comment on view public.shopify_credential_status is
  'Per-connection setup status (has_token / has_secret) for the integrations UI. Owner-privileged so it can read the sealed shopify_secrets table, but exposes only booleans, never secret values. Row access scoped by can_access_site.';

grant select on public.shopify_credential_status to authenticated;

commit;
