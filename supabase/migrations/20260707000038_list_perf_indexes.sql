-- ============================================================================
-- Migration 0038: indexes backing the list-screen sorts + pagination
-- ----------------------------------------------------------------------------
-- Root cause of "canceling statement due to statement timeout" on /orders: the
-- orders list sorts by entered_at desc on every load, but only site_id/status/
-- customer_id/group_id were indexed — so Postgres sorted the whole RLS-filtered
-- table each time and intermittently blew the role statement_timeout on a cold
-- cache. Same shape on the catalog and intake logs. These indexes let the
-- planner satisfy the ORDER BY ... LIMIT with an index scan instead of a full
-- sort, which is also what makes range() pagination cheap.
--
-- Plain (non-CONCURRENT) CREATE INDEX so this file stays transactional like the
-- rest of the migration set and round-trips through the rollback cleanly. The
-- tables are small at this stage, so the brief write lock is negligible; if any
-- of these tables is large by the time this runs, build the equivalent index
-- CONCURRENTLY out-of-band first and this IF NOT EXISTS will no-op.
--
-- Reverse with rollback/20260707000038_list_perf_indexes.down.sql.
-- ============================================================================
begin;

-- Orders: default sort is entered_at desc; sale_date is a selectable sort;
-- site-scoped managers filter by site_id and then sort by entered_at.
create index if not exists orders_entered_at_idx
  on public.orders (entered_at desc);
create index if not exists orders_sale_date_idx
  on public.orders (sale_date desc);
create index if not exists orders_site_entered_at_idx
  on public.orders (site_id, entered_at desc);

-- Catalog: the products list sorts by name.
create index if not exists products_name_idx
  on public.products (name);

-- Intake history: the allocations log sorts by created_at desc (no filter).
create index if not exists allocations_created_at_idx
  on public.allocations (created_at desc);

-- Intake receipts: parent_inventory_ledger is filtered by reason ('intake')
-- and then sorted by created_at desc.
create index if not exists parent_inventory_ledger_reason_created_idx
  on public.parent_inventory_ledger (reason, created_at desc);

commit;
