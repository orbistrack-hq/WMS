-- ============================================================================
-- WMS — Migration 0096: ship_conflict flag (cancelled-but-shipped visibility)
--
-- WHY. The WOO- orders the fulfillment team found (cancelled in OT, shipped in
-- ShipStation anyway) were only discoverable by manually running the
-- /integrations/shipstation alignment check. The underlying reason nobody saw it
-- sooner: applyWooLifecycleUpdate / applyShopifyLifecycleUpdate deliberately
-- treat 'cancelled'/'fulfilled' as terminal and silently no-op any later webhook
-- (lib/woocommerce/import-orders.ts, lib/shopify/import-orders.ts — "store-side
-- completed/cancelled wins, forward-only"). That guard is correct — WMS should
-- not get yanked around by out-of-order webhooks — but it means the exact
-- signal that would have caught this (a later "it shipped" event arriving for
-- an order OT already shows cancelled) vanished with zero record.
--
-- WHAT. Two plain columns on orders, stamped the moment a conflict is detected,
-- by TWO independent paths (app code, migration 0097+):
--   * the real-time webhook path (the noop branch above), the instant a later
--     "shipped" event arrives for an order already cancelled;
--   * a scheduled ShipStation cross-check sweep (belt-and-suspenders for when
--     the store never re-fires a webhook at all — e.g. ShipStation ships an
--     order without the store's own status ever flipping to completed, so
--     there's no webhook to intercept in the first place).
-- Both write through one small helper (lib/store-sync/ship-conflict.ts),
-- idempotent (only stamps once), so the order/orders-list UI can show a banner
-- immediately instead of relying on someone remembering to check.
--
-- Data-only (no RPC/behavior change here); additive and fully reversible.
-- ============================================================================

begin;

alter table public.orders
  add column if not exists ship_conflict_at   timestamptz,
  add column if not exists ship_conflict_note text;

comment on column public.orders.ship_conflict_at is
  'Set the moment WMS detects this order shipped at the store/ShipStation after already being cancelled here (via a later webhook event or the scheduled ShipStation cross-check). Surfaces a review banner; cleared only by resolving the order (e.g. fulfill_cancelled_order). Null = no known conflict.';
comment on column public.orders.ship_conflict_note is
  'Human-readable detail for ship_conflict_at — which signal caught it and when.';

commit;
