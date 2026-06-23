-- WMS — Migration 0007: DOWN
begin;
drop function if exists public.cancel_order(uuid);
drop function if exists public.fulfill_order(uuid);
drop function if exists public.set_order_status(uuid, text);
commit;
