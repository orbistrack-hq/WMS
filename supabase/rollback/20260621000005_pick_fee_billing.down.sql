-- ============================================================================
-- WMS — Migration 0005: DOWN (reverses 0005_pick_fee_billing.up.sql)
-- ============================================================================
begin;
drop function if exists public.charge_group_pick_fees(uuid, boolean);
drop function if exists public.charge_order_pick_fee(uuid, boolean);
drop function if exists public.calc_order_pick_fee(uuid, date);
drop function if exists public.resolve_fee_schedule(date, uuid);
drop function if exists public.pick_fee_amount(integer, numeric, numeric);
drop index if exists public.billing_charges_one_pick_fee;
commit;
