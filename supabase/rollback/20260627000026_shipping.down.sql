-- WMS — Migration 0026: DOWN
-- Drops the shipping RPCs. The shipments/packages tables, RLS, and report view
-- predate this migration (0001/0004/0009) and are left intact.
begin;

drop function if exists public.update_package(uuid, text, numeric, integer);
drop function if exists public.add_package(uuid, text, numeric, integer);
drop function if exists public.set_shipment_status(uuid, text);
drop function if exists public.update_shipment(uuid, text, text, numeric, numeric);
drop function if exists public.create_shipment(uuid, text, text, numeric);

commit;
