-- ============================================================================
-- Migration 0042: index the packing-queue filter + sort on fulfillment_groups
-- ----------------------------------------------------------------------------
-- The /packing screen runs, on every load:
--     WHERE status = 'open' ORDER BY window_start ASC LIMIT 300
-- but fulfillment_groups had NO indexes at all, so Postgres full-scanned and
-- sorted the whole table each time. As orders are completed their group flips
-- to 'fulfilled' and stays in the table, so the scan grows without bound and
-- intermittently blows the role statement_timeout — the same failure mode that
-- hit the /orders list (fixed in 0038). A composite (status, window_start) lets
-- the planner satisfy the status filter and the window_start ORDER BY straight
-- from the index.
--
-- Plain (non-CONCURRENT) CREATE INDEX to stay transactional with the rest of
-- the migration set; if fulfillment_groups is already large when this runs,
-- build the equivalent index CONCURRENTLY out-of-band first and this no-ops.
--
-- Reverse with rollback/20260707000042_packing_queue_index.down.sql.
-- ============================================================================
begin;

create index if not exists fulfillment_groups_status_window_idx
  on public.fulfillment_groups (status, window_start);

commit;
