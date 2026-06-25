-- WMS — Migration 0016: DOWN
begin;
alter function public.create_inventory_level() security invoker;
alter function public.create_inventory_level() reset search_path;
commit;
