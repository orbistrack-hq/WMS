-- WMS — Migration 0013: DOWN
begin;
drop table if exists public.shopify_order_imports;
drop table if exists public.shopify_connections;
commit;
