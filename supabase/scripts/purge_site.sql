-- ============================================================================
-- purge_site.sql — hard-delete a site and everything scoped to it.
--
-- DESTRUCTIVE AND IRREVERSIBLE. Intended for dev/test sites that were created
-- by mistake and have accumulated junk data. Do not run against a site that
-- holds real orders, inventory, or billing history — archive it instead
-- (Settings > Sites > deactivate, which now hides it from every picker).
--
-- Deletes run in FK-safe order. Tables not listed here are removed implicitly
-- by `on delete cascade`:
--   orders              -> order_line_items, order_payments
--   fulfillment_groups  -> packaging_usage, shipments (-> packages),
--                          pick_progress, pick_claims
--   allocations         -> allocation_lines
--   child_skus          -> inventory_levels, store_outbound_inventory_jobs
--   sites               -> packaging_types (-> packaging_levels,
--                          packaging_weight_rule, packaging_order_default),
--                          user_site_access, store_outbound_inventory_jobs
--
-- Usage: set the uuid below, run in the Supabase SQL editor. The whole block
-- is one transaction — any failure rolls the entire purge back.
-- ============================================================================

do $$
declare
  sid    uuid := '00000000-0000-0000-0000-000000000000';  -- <-- site id
  sname  text;
begin
  select name into sname from public.sites where id = sid;
  if sname is null then
    raise exception 'No site with id %', sid;
  end if;
  raise notice 'Purging site % (%)', sname, sid;

  -- Billing charges pin their order with `restrict`, so they go first.
  delete from public.billing_charges
   where order_id in (select id from public.orders where site_id = sid);

  -- Orders before fulfillment_groups: orders -> groups is `restrict`.
  delete from public.orders where site_id = sid;
  delete from public.fulfillment_groups where site_id = sid;

  delete from public.allocations where site_id = sid;

  -- inventory_ledger pins child_skus with `restrict`.
  delete from public.inventory_ledger
   where child_sku_id in (select id from public.child_skus where site_id = sid);
  delete from public.child_skus where site_id = sid;

  -- Site-scoped ledgers and config that block the site row directly.
  delete from public.packaging_ledger       where site_id = sid;
  delete from public.parent_inventory_ledger where site_id = sid;
  delete from public.stock_transfers
   where source_site_id = sid or dest_site_id = sid;
  delete from public.store_connections      where site_id = sid;

  delete from public.sites where id = sid;
  raise notice 'Purged site % (%)', sname, sid;
end $$;
