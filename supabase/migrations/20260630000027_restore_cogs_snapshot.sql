-- ============================================================================
-- WMS — Migration 0027: restore the COGS snapshot in apply_order_fulfillment
--
-- REGRESSION FIX. Migration 0019 froze each order line's product cost at
-- fulfillment (order_line_items.unit_cost_snapshot) so COGS / gross-margin
-- reports have a stable cost basis. Migration 0024 (backorder state) then
-- redefined apply_order_fulfillment to add the backordered-quantity guard but
-- DROPPED the snapshot UPDATE — so since 0024, fulfilling an order left
-- unit_cost_snapshot NULL and cogs_report showed zero COGS / inflated profit.
--
-- This redefines apply_order_fulfillment to do BOTH: keep 0024's backorder guard
-- AND restore 0019's cost snapshot (idempotent per line: only fills nulls, so a
-- later cost edit never rewrites history). Function-body-only change; no schema
-- or data migration. Reverse with the down file (returns to the 0024 body).
-- ============================================================================

begin;

create or replace function public.apply_order_fulfillment(p_order_id uuid)
returns void language plpgsql as $$
declare r record; v_type text; v_back integer;
begin
  select order_type into v_type from public.orders where id = p_order_id;
  if v_type is null then raise exception 'Order % not found', p_order_id; end if;

  -- Backorder guard (from migration 0024): can't ship while units are owed.
  select coalesce(sum(backordered_qty), 0) into v_back
    from public.order_line_items where order_id = p_order_id;
  if v_back > 0 then
    raise exception
      'Cannot fulfill order %: % unit(s) still backordered awaiting stock',
      p_order_id, v_back using errcode = 'check_violation';
  end if;

  -- COGS basis (restored from migration 0019): freeze each line's current
  -- product cost at the sale moment. Only fills nulls, so later cost edits
  -- never rewrite an already-recorded snapshot.
  update public.order_line_items li
     set unit_cost_snapshot = cs.cost
    from public.child_skus cs
   where li.order_id = p_order_id
     and cs.id = li.child_sku_id
     and li.unit_cost_snapshot is null;

  for r in
    select id, child_sku_id, quantity
      from public.order_line_items where order_id = p_order_id
  loop
    if v_type = 'layaway' then
      perform public.layaway_consume(r.child_sku_id, r.quantity, 'order_line_item', r.id);
    else
      perform public.consume_stock(r.child_sku_id, r.quantity, 'order_line_item', r.id);
    end if;
  end loop;
end;
$$;

commit;
