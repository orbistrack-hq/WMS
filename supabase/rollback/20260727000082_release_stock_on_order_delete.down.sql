-- ============================================================================
-- WMS — Rollback 0082: remove the order-delete stock release
--
-- Drops the trigger and its function, restoring the prior behaviour where
-- deleting an order strands its reservation.
--
-- OPERATIONAL NOTE: after reversing this, any order deleted while holding stock
-- again leaves inventory_levels.reserved inflated with no order left to release
-- it. Follow every such deletion with scripts/recompute-reservations.sql.
--
-- Round-trip safe: creates nothing the forward migration did not create, and
-- touches no data.
-- ============================================================================

begin;

drop trigger if exists order_delete_release_stock on public.orders;
drop function if exists public.release_stock_on_order_delete();

commit;
