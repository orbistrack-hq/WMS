-- WMS — Migration 0014: DOWN
begin;
drop function if exists public.upsert_shopify_variant(uuid, text, text, text, numeric);
drop table if exists public.shopify_secrets;
alter table public.shopify_connections drop column if exists last_synced_at;
commit;
