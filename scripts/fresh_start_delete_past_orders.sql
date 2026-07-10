-- ============================================================================
-- Fresh start: delete all orders ENTERED before today, then recompute inventory.
--
-- Scope decision : cutoff = orders.entered_at < start of today (NOT sale_date).
-- Inventory      : reserved / layby are RECOMPUTED from the orders that remain,
--                  with a correction row written to inventory_ledger.
--
-- WHY the recompute matters:
--   Deleting an order does NOT release its reserved stock. There is no
--   delete-time inventory logic in the schema, so every unfulfilled order you
--   delete would otherwise leave inventory_levels.reserved inflated (and
--   available understated) forever. This script fixes that in the same txn.
--
-- BEFORE RUNNING:
--   1. Take a backup (Supabase dashboard > Database > Backups, or pg_dump).
--   2. Run the PREVIEW block below on its own first and sanity-check the counts.
--   3. Confirm the timezone note on the cutoff (see step 1).
-- ============================================================================


-- ----------------------------------------------------------------------------
-- PREVIEW (read-only) — run this first, outside the transaction.
-- ----------------------------------------------------------------------------
select
  count(*)                                              as orders_to_delete,
  count(*) filter (where order_type = 'layaway')        as layaway_to_delete,
  count(*) filter (where status not in ('fulfilled','cancelled')) as active_holding_stock,
  min(entered_at)                                       as earliest,
  max(entered_at)                                       as latest
from public.orders
where entered_at < date_trunc('day', now());   -- cutoff (see timezone note)


-- ============================================================================
-- DELETE + RECOMPUTE  (transactional — all or nothing)
-- ============================================================================
begin;

-- 1. Single source of truth for the cutoff. Snapshot the target order ids.
--    TIMEZONE: date_trunc('day', now()) uses the DB session zone. After
--    migration 0049 that is America/Los_Angeles, so "today" already means the
--    Pacific day. To pin an explicit boundary instead, use e.g.
--      where entered_at < timestamptz '2026-07-09 00:00:00-07'
create temporary table _orders_to_delete on commit drop as
select id, group_id
from public.orders
where entered_at < date_trunc('day', now());

-- 2. Clear child rows that would otherwise BLOCK the order delete.
--    billing_charges is ON DELETE RESTRICT, so it must go first.
delete from public.billing_charges
where order_id in (select id from _orders_to_delete);

--    store_order_imports is ON DELETE SET NULL (does NOT block the delete).
--    DEFAULT = keep them: with wms_order_id nulled they act as idempotency
--    tombstones so a future backfill/webhook can't re-pull these old orders.
--    Uncomment ONLY if you want those external orders to be re-importable:
-- delete from public.store_order_imports
-- where wms_order_id in (select id from _orders_to_delete);

-- 3. Delete the orders.
--    Cascades automatically: order_line_items, order_payments.
delete from public.orders
where id in (select id from _orders_to_delete);

-- 4. Delete fulfillment groups left with no remaining orders.
--    Cascades automatically: packaging_usage, shipments -> packages,
--    pick_progress, pick_claims.
delete from public.fulfillment_groups g
where g.id in (select group_id from _orders_to_delete)
  and not exists (select 1 from public.orders o where o.group_id = g.id);

-- 5. Recompute reserved / layby for EVERY sku from the orders that survive.
--    reserved = open standard orders; layby = open layaway orders.
--    (status not in fulfilled/cancelled; holds still count as reserved.)
--
--    CRITICAL: a line's RESERVED amount is (quantity - backordered_qty), NOT
--    quantity (migration 0024). Store imports run with allow_backorder, so a
--    line that was short at import has part of its quantity backordered and
--    never reserved. Summing raw quantity overcounts reserved and can exceed
--    on_hand, tripping the on_hand >= reserved constraint. Layaway never
--    backorders (backordered_qty is 0 there), so its sum is unaffected.
create temporary table _recompute on commit drop as
select cs.id                                            as child_sku_id,
       il.reserved                                      as old_reserved,
       il.layby                                         as old_layby,
       coalesce(sum(li.quantity - li.backordered_qty) filter (
         where o.order_type = 'standard'
           and o.status not in ('fulfilled','cancelled')), 0) as new_reserved,
       coalesce(sum(li.quantity) filter (
         where o.order_type = 'layaway'
           and o.status not in ('fulfilled','cancelled')), 0) as new_layby
from public.child_skus cs
join public.inventory_levels il      on il.child_sku_id = cs.id
left join public.order_line_items li on li.child_sku_id = cs.id
left join public.orders o            on o.id = li.order_id
group by cs.id, il.reserved, il.layby;

-- 5-guard. Prove the recompute is sound BEFORE writing: no sku may end with
-- reserved > on_hand. Should never fire (surviving reserved <= old reserved <=
-- on_hand), but if the source data is already inconsistent this aborts with a
-- readable message and a count, instead of a bare check-constraint error.
do $$
declare v_bad integer;
begin
  select count(*) into v_bad
  from _recompute r
  join public.inventory_levels il on il.child_sku_id = r.child_sku_id
  where r.new_reserved > il.on_hand;
  if v_bad > 0 then
    raise exception
      'Aborting: % sku(s) would have reserved > on_hand after recompute. '
      'Inspect: select r.* from _recompute r join public.inventory_levels il '
      'on il.child_sku_id = r.child_sku_id where r.new_reserved > il.on_hand;', v_bad;
  end if;
end $$;

-- 5a. Log the corrections (append-only ledger keeps the audit trail intact).
insert into public.inventory_ledger
       (child_sku_id, delta_reserved, delta_layby, reason, note)
select child_sku_id,
       new_reserved - old_reserved,
       new_layby    - old_layby,
       'correction',
       'fresh-start cleanup: reservations recomputed after deleting pre-today orders'
from _recompute
where new_reserved <> old_reserved
   or new_layby    <> old_layby;

-- 5b. Apply the recomputed levels.
update public.inventory_levels il
set reserved   = r.new_reserved,
    layby      = r.new_layby,
    updated_at = now()
from _recompute r
where il.child_sku_id = r.child_sku_id
  and (il.reserved <> r.new_reserved or il.layby <> r.new_layby);

-- Review the transaction, then COMMIT (or ROLLBACK to back out).
commit;


-- ----------------------------------------------------------------------------
-- NOT touched by this script (by design) — decide separately if you care:
--
--  * inventory_levels.on_hand for LAYAWAY orders: layaway removed stock from
--    on_hand at creation. Deleting the order does NOT put it back. If any
--    pre-today layaway orders existed, on_hand is now understated by that
--    physical amount — fix with a manual_adjustment after a recount.
--
--  * inventory_ledger / audit_log history: kept as the historical record. The
--    delete itself also writes DELETE rows to audit_log via the audit trigger.
--
--  * customers: not deleted (may be reused). To drop ones now orphaned:
--      -- delete from public.customers c
--      -- where not exists (select 1 from public.orders o where o.customer_id = c.id)
--      --   and not exists (select 1 from public.fulfillment_groups g where g.customer_id = c.id);
--
--  * order_number_seq: NOT reset — new orders keep counting up (ORD-000NNN).
--    To restart numbering (optional, only safe now that old numbers are gone):
--      -- alter sequence public.order_number_seq restart with 1;
-- ----------------------------------------------------------------------------
