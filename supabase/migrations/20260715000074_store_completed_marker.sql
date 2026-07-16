-- ============================================================================
-- WMS — Migration 0074: store-completion marker
--
-- Problem: with store auto-fulfill OFF (the default — so the team packs locally
-- and captures packaging cost), a store order that gets marked completed
-- upstream leaves NO trace in OT. The order sits as `created` with no sign the
-- store considers it done, so the only way to surface it is a manual reconcile.
--
-- Fix (confirmed with the team): record WHEN the source store marked the order
-- completed, WITHOUT changing OT status. A `created` order with this set is
-- "done at the store, still needs local packing/fulfilment". Sync sets it
-- automatically (webhook + nightly safety-net); the team still fulfils by hand.
--
-- Marker only — no status change, no inventory effect. Reversible.
-- ============================================================================

begin;

alter table public.orders add column store_completed_at timestamptz;

comment on column public.orders.store_completed_at is
  'When the source store (Woo/Shopify) marked this order completed/fulfilled, recorded automatically by sync WITHOUT changing OT status or touching inventory. A created order with this set is done at the store but still needs local packing/fulfilment. Null = the store has not completed it.';

commit;
