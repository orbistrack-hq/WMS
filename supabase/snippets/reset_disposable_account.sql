-- ============================================================================
-- ⚠️  DESTRUCTIVE — DISPOSABLE / STAGING ACCOUNT ONLY  ⚠️
--
-- Wipes the transactional catalog so a fresh store sync rebuilds it cleanly with
-- the migration-0030 forward weight grouping (one strain parent -> weight-variant
-- children). Use this ONLY on the throwaway account. NEVER run in production.
--
-- It DELETES: products, child SKUs, all inventory + ledgers, orders + line items
--   + payments + customers, fulfillment/packing/shipping, billing charges, store
--   import/sync job state, and the audit log.
--
-- It KEEPS (config, needed to resync): sites, profiles + site access,
--   packaging_types + packaging stock, fee_schedules, categories, and the
--   Shopify/store connections + secrets.
--
-- HOW TO USE
--   1. Review the counts printed by the SELECT block below.
--   2. Run the whole file (Supabase SQL editor). It is wrapped in a transaction.
--   3. Go to Integrations → your store → re-run product sync. The forward weight
--      grouping (0030) runs automatically — no backfill needed on a fresh sync.
-- ============================================================================

-- ---- 1. Pre-flight: what will be removed --------------------------------------
select 'products'        as table, count(*) from public.products
union all select 'child_skus',       count(*) from public.child_skus
union all select 'orders',           count(*) from public.orders
union all select 'order_line_items', count(*) from public.order_line_items
union all select 'inventory_levels', count(*) from public.inventory_levels
union all select 'fulfillment_groups', count(*) from public.fulfillment_groups
union all select 'shipments',        count(*) from public.shipments;

-- ---- 2. The wipe (transactional) ----------------------------------------------
-- TRUNCATE the transactional set in one statement so inter-table FKs resolve.
-- CASCADE only reaches tables that reference these (all listed here); the config
-- tables above are referenced BY these, so they are never touched.
begin;

truncate table
  public.billing_charges,
  public.packaging_usage,
  public.packages,
  public.shipments,
  public.pick_claims,
  public.pick_progress,
  public.fulfillment_groups,
  public.order_payments,
  public.order_line_items,
  public.orders,
  public.customers,
  public.allocation_lines,
  public.allocations,
  public.parent_inventory_ledger,
  public.parent_inventory,
  public.inventory_ledger,
  public.inventory_levels,
  public.product_merge_log,
  public.child_skus,
  public.products,
  public.store_order_imports,
  public.store_sync_jobs,
  public.store_outbound_inventory_jobs,
  public.audit_log
restart identity cascade;

commit;

-- ---- 3. Verify empty ----------------------------------------------------------
select 'products' as table, count(*) from public.products
union all select 'child_skus', count(*) from public.child_skus
union all select 'orders',     count(*) from public.orders;
