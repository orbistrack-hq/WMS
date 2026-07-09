-- WMS — Migration 0047: DOWN
begin;

drop index if exists public.products_sku_idx;

alter table public.products
  drop column if exists sku;

commit;
