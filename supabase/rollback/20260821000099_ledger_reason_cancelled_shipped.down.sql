-- Rollback for migration 0099. Restores the 0078 reason list (drops
-- 'cancelled_order_shipped'). Only safe if no ledger rows use that reason yet.

begin;

alter table public.inventory_ledger drop constraint inventory_ledger_reason_check;
alter table public.inventory_ledger add constraint inventory_ledger_reason_check
  check (reason in (
    'order_reserve','order_release','order_consume',
    'layaway_remove','layaway_cancel','layaway_consume',
    'manual_adjustment','receipt','correction',
    'shopify_sync',
    'order_return',
    'transfer_out','transfer_in'));

commit;
