-- ============================================================================
-- WMS — Migration 0048: per-connection order-sync cutoff (sync_orders_since).
--
-- WHY: when a store goes live on WMS we do NOT want its historical orders pulled
-- in — neither by the past-orders backfill nor by the webhook self-heal path
-- (orders/updated for an order we never imported falls through to an import).
-- This adds a per-connection floor date: orders whose store-side created_at is
-- before it are never imported.
--
-- Nullable => "no floor" (import everything, the pre-0048 behaviour). Existing
-- rows are backfilled to the start of today so live stores don't suddenly ingest
-- history on the next sync; set to null explicitly to re-enable full backfill.
--
-- Reverse with rollback/20260709000048_store_sync_orders_since.down.sql.
-- ============================================================================

begin;

alter table public.store_connections
  add column sync_orders_since timestamptz;

comment on column public.store_connections.sync_orders_since is
  'Order-sync floor: orders with a store-side created_at before this are skipped by both the backfill and the webhook importer. Null = no floor (import all history).';

-- Backfill existing connections to the start of today so a fresh-start store
-- does not pull historical orders on its next sync. New connections default to
-- null; the integrations UI sets this at connect time.
update public.store_connections
set sync_orders_since = date_trunc('day', now())
where sync_orders_since is null;

commit;
