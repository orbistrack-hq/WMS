-- ============================================================================
-- WMS — Migration 0064: fulfill_order_no_stock (inventory-neutral fulfillment)
--
-- WHY. Orders that were completed/shipped at the store BEFORE OT tracked their
-- inventory (the historical backfill) must be recorded as fulfilled, but their
-- stock already left the building before OT's on-hand was seeded. Running them
-- through the normal fulfill_order would (a) be blocked outright when the line
-- is backordered, and (b) consume on_hand a SECOND time for the ones that aren't
-- — double-depleting inventory and shoving other orders into false backorder.
--
-- WHAT. A guarded, inventory-NEUTRAL fulfillment for exactly these historical
-- store completions:
--   * snapshots COGS (same as apply_order_fulfillment) so margin reports have a
--     cost basis — fills nulls only, never rewrites history;
--   * RELEASES the reserved portion of each line (undoes the reservation OT took
--     at import, freeing that stock for real/future orders);
--   * clears any backordered_qty and the orders.backordered flag (OT does not
--     owe stock it already shipped);
--   * does NOT consume on_hand, and does NOT charge the pick fee (it was not
--     packed in OT);
--   * marks the order fulfilled + backdated + auto_fulfilled and closes the
--     fulfillment group when all its orders are fulfilled.
--
-- Standard orders only — layaway has its own booking lifecycle and never arrives
-- via store import; passing one raises rather than guessing.
--
-- This is for the one-time historical reconcile (scripts/reconcile-store-orders
-- --no-stock). The LIVE auto-fulfill path keeps using fulfill_order so orders OT
-- actually reserved stock for consume normally. New function; fully reversible
-- (rollback drops it).
-- ============================================================================

begin;

create or replace function public.fulfill_order_no_stock(
  p_order_id     uuid,
  p_fulfilled_at timestamptz default null
)
returns public.orders language plpgsql as $$
declare
  v          public.orders;
  v_at       timestamptz := coalesce(p_fulfilled_at, now());
  r          record;
  v_reserved integer;
begin
  select * into v from public.orders where id = p_order_id for update;
  if not found then raise exception 'Order % not found', p_order_id; end if;
  if v.status = 'fulfilled' then raise exception 'Order % already fulfilled', p_order_id; end if;
  if v.status = 'cancelled' then raise exception 'Order % is cancelled and cannot be fulfilled', p_order_id; end if;
  if v.status = 'returned' then raise exception 'Order % is returned; re-open it before fulfilling', p_order_id; end if;
  if v.order_type <> 'standard' then
    raise exception 'fulfill_order_no_stock is for standard orders only (order % is %)', p_order_id, v.order_type;
  end if;

  -- COGS basis (mirrors apply_order_fulfillment): freeze current cost, nulls only.
  update public.order_line_items li
     set unit_cost_snapshot = cs.cost
    from public.child_skus cs
   where li.order_id = p_order_id
     and cs.id = li.child_sku_id
     and li.unit_cost_snapshot is null;

  -- Inventory-neutral: release the reserved portion, clear the backorder, but
  -- never touch on_hand — the physical units left before OT tracked this stock.
  for r in
    select id, child_sku_id, quantity, backordered_qty
      from public.order_line_items where order_id = p_order_id
  loop
    v_reserved := r.quantity - coalesce(r.backordered_qty, 0);
    if v_reserved > 0 then
      perform public.release_stock(r.child_sku_id, v_reserved, 'order_line_item', r.id);
    end if;
    if coalesce(r.backordered_qty, 0) > 0 then
      update public.order_line_items set backordered_qty = 0 where id = r.id;
    end if;
  end loop;

  update public.orders
     set status = 'fulfilled',
         fulfilled_at = v_at,
         auto_fulfilled = true,
         backordered = false
   where id = p_order_id returning * into v;

  update public.fulfillment_groups g set status = 'fulfilled', fulfilled_at = v_at
   where g.id = v.group_id
     and not exists (select 1 from public.orders o where o.group_id = g.id and o.status <> 'fulfilled');
  return v;
end;
$$;

grant execute on function public.fulfill_order_no_stock(uuid, timestamptz) to authenticated;

comment on function public.fulfill_order_no_stock is
  'Inventory-neutral fulfillment for historical store completions: releases reservations, clears backorders, snapshots COGS, and marks the order fulfilled/backdated/auto_fulfilled WITHOUT consuming on_hand or charging the pick fee. Standard orders only. Use for the one-time reconcile of orders shipped before OT tracked their inventory; the live path uses fulfill_order.';

commit;
