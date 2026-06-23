-- WMS — Migration 0006: DOWN
begin;
drop function if exists public.record_order_payment(uuid, numeric, text, text);
drop view if exists public.order_payment_summary;
drop table if exists public.order_payments cascade;
commit;
