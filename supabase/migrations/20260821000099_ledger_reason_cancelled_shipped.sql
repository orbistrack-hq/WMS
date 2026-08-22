-- ============================================================================
-- WMS — Migration 0099: inventory_ledger reason — add cancelled_order_shipped
--
-- BUG. fulfill_cancelled_order (migrations 0097/0098) writes its on_hand
-- depletion via _inv_write with reason 'cancelled_order_shipped' — a value
-- never added to inventory_ledger's reason check constraint (last set in
-- migration 0078: order_reserve/order_release/order_consume/layaway_*/
-- manual_adjustment/receipt/correction/shopify_sync/order_return/transfer_*).
-- Every write hit "new row for relation inventory_ledger violates check
-- constraint inventory_ledger_reason_check" — the fix never actually worked.
--
-- FIX. Preserve the full current list (per the 0078 convention) and add
-- 'cancelled_order_shipped' — kept distinct from 'correction' (used for the
-- newer-reservation demotion notes in the same function) so the two halves of
-- one fulfill_cancelled_order run are separately identifiable in the ledger:
-- which row is the actual shipped-unit depletion vs. which is a knock-on
-- backorder note on a different order.
-- ============================================================================

begin;

alter table public.inventory_ledger drop constraint inventory_ledger_reason_check;
alter table public.inventory_ledger add constraint inventory_ledger_reason_check
  check (reason in (
    'order_reserve','order_release','order_consume',
    'layaway_remove','layaway_cancel','layaway_consume',
    'manual_adjustment','receipt','correction',
    'shopify_sync',
    'order_return',
    'transfer_out','transfer_in',
    'cancelled_order_shipped'));

commit;
