-- WMS — Migration 0012: DOWN
begin;
drop function if exists public.pack_group(uuid, text);
drop function if exists public.record_packaging_usage(uuid, uuid, integer);
alter table public.fulfillment_groups drop column if exists packing_notes;
commit;
