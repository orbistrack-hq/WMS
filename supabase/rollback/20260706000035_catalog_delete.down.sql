-- WMS — Migration 0035 (catalog_delete): DOWN
begin;
drop function if exists public.delete_child_sku(uuid);
drop function if exists public.delete_product(uuid);
commit;
