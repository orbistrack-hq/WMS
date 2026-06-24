-- WMS — Migration 0010: DOWN
begin;
drop function if exists public.create_order(
  uuid, jsonb, uuid, text, text, date, timestamptz,
  text, text, text, text, text, text, text,
  numeric, numeric, text
);
commit;
