-- ============================================================================
-- WMS — Migration 0002: DOWN (reverses 0002_inventory_state_machine.up.sql)
-- ============================================================================

begin;

drop function if exists public.apply_order_fulfillment(uuid);
drop function if exists public.apply_order_cancellation(uuid);
drop function if exists public.apply_order_creation(uuid);
drop function if exists public.adjust_stock(uuid, integer, text, text, uuid);
drop function if exists public.receive_stock(uuid, integer, text, uuid, text);
drop function if exists public.layaway_consume(uuid, integer, text, uuid);
drop function if exists public.layaway_cancel(uuid, integer, text, uuid);
drop function if exists public.layaway_book(uuid, integer, text, uuid);
drop function if exists public.consume_stock(uuid, integer, text, uuid);
drop function if exists public.release_stock(uuid, integer, text, uuid);
drop function if exists public.reserve_stock(uuid, integer, text, uuid);
drop function if exists public._inv_lock(uuid);
drop function if exists public._inv_write(uuid, integer, integer, integer, text, text, uuid, text);

-- Revert the ledger reason vocabulary to the original 0001 set.
alter table public.inventory_ledger drop constraint inventory_ledger_reason_check;
alter table public.inventory_ledger add constraint inventory_ledger_reason_check
  check (reason in (
    'order_reserve','order_release','order_consume',
    'layaway_remove','manual_adjustment','receipt','correction'));

commit;
