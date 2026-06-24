-- WMS — Migration 0015: DOWN  (restores admin-only Shopify policies)
begin;

drop policy if exists shopify_connections_rw on public.shopify_connections;
create policy shopify_connections_read on public.shopify_connections
  for select using (auth.uid() is not null);
create policy shopify_connections_admin on public.shopify_connections
  for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists shopify_secrets_rw on public.shopify_secrets;
create policy shopify_secrets_admin on public.shopify_secrets
  for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists shopify_order_imports_read on public.shopify_order_imports;
create policy shopify_order_imports_read on public.shopify_order_imports
  for select using (auth.uid() is not null);

alter table public.shopify_secrets drop column if exists api_secret;
commit;
