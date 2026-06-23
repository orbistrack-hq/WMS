-- WMS — Migration 0008: DOWN
begin;
drop function if exists public.combine_orders(uuid[]);
drop function if exists public.combinable_orders(uuid);
drop function if exists public.group_packaging_cost(uuid);
commit;
