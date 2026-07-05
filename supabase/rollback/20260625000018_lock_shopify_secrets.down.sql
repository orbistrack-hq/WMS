-- WMS — Migration 0018 (lock_shopify_secrets): DOWN
-- ⚠️  WARNING: this REVERSES the secrets lockdown — it re-grants the API role
-- (authenticated) read/write on public.shopify_secrets and restores the
-- site-scoped RW policy, re-exposing Admin API tokens and webhook secrets via
-- PostgREST. It exists only for strict reversibility (full rollback past 0018).
-- Do NOT run this against production unless you are deliberately rolling the
-- schema back to before 0018.
begin;
drop view if exists public.shopify_credential_status;
grant select, insert, update, delete on public.shopify_secrets to authenticated;
create policy shopify_secrets_rw on public.shopify_secrets
  for all
  using (exists (
    select 1 from public.shopify_connections c
     where c.id = connection_id and public.can_access_site(c.site_id)))
  with check (exists (
    select 1 from public.shopify_connections c
     where c.id = connection_id and public.can_access_site(c.site_id)));
commit;
