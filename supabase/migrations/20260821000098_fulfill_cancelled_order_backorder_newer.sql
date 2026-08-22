-- ============================================================================
-- WMS — Migration 0098: fulfill_cancelled_order — auto-demote newer reservations
--
-- WHY. Migration 0097 removed the application-level "don't drop on_hand below
-- reserved" guard, but inventory_levels has a HARD table constraint
-- (`check (on_hand >= reserved)`, migration 0001 — "guard against overselling")
-- that no function can bypass. So depleting on_hand for a cancelled-but-shipped
-- order still fails outright whenever some OTHER still-open order is currently
-- reserving stock this order already physically consumed.
--
-- That's a real, understood sequence, not a data-integrity mystery: this order
-- was wrongly cancelled, which released its reservation; some later order then
-- legitimately reserved (and in some cases already fulfilled and shipped) that
-- same stock, believing it was genuinely free — it wasn't, because this order
-- had already shipped it out from under the books. The fair resolution
-- (confirmed with the team): whichever order reserved the stock LATER loses
-- its claim to it, not this one — this order's shipment already happened and
-- can't be undone; the later order becomes backordered until restock instead.
--
-- WHAT. Before depleting on_hand for a line, if that would drop on_hand below
-- the SKU's current `reserved`, automatically claw back just enough of the
-- shortfall from the NEWEST other open (created/picking/packed) reservations
-- of the same SKU — release_stock + backordered_qty, same mechanism
-- apply_order_creation uses going the other direction — newest first (LIFO:
-- the most recently reserved order is the one that "shouldn't" have gotten
-- this stock). Each demotion writes its own audit note to inventory_ledger
-- (mirrors force_fulfill_order's zero-delta 'correction' rows) naming both
-- orders, so it's traceable and the demoted order's own audit trail explains
-- why it went backordered. If the newest reservations still can't cover the
-- full shortfall, this raises rather than guessing further — that's a genuine
-- physical shortage (on_hand itself is wrong) needing a real recount, not
-- something a backorder shuffle can paper over.
--
-- No signature change. Rollback restores the 0097 body (raises immediately on
-- any shortfall instead of auto-demoting).
-- ============================================================================

begin;

create or replace function public.fulfill_cancelled_order(
  p_order_id     uuid,
  p_reason       text,
  p_fulfilled_at timestamptz default null
)
returns public.orders
language plpgsql security definer set search_path = '' as $$
declare
  v          public.orders;
  v_at       timestamptz := coalesce(p_fulfilled_at, now());
  v_reason   text := nullif(trim(coalesce(p_reason, '')), '');
  r          record;
  d          record;
  v_lvl      public.inventory_levels;
  v_shortfall integer;
  v_take     integer;
begin
  if public.app_role() not in ('admin', 'manager') then
    raise exception 'fulfill_cancelled_order requires the admin or manager role'
      using errcode = 'insufficient_privilege';
  end if;
  if v_reason is null then
    raise exception 'fulfill_cancelled_order requires a reason (it is written to the inventory ledger)';
  end if;

  select * into v from public.orders where id = p_order_id for update;
  if not found then raise exception 'Order % not found', p_order_id; end if;
  if v.status <> 'cancelled' then
    raise exception 'fulfill_cancelled_order is for cancelled orders only (order % is %)', p_order_id, v.status;
  end if;
  if v.order_type <> 'standard' then
    raise exception 'fulfill_cancelled_order is for standard orders only (order % is %)', p_order_id, v.order_type;
  end if;

  -- COGS basis (mirrors apply_order_fulfillment): freeze current cost, nulls only.
  update public.order_line_items li
     set unit_cost_snapshot = cs.cost
    from public.child_skus cs
   where li.order_id = p_order_id
     and cs.id = li.child_sku_id
     and li.unit_cost_snapshot is null;

  for r in
    select oli.id, oli.child_sku_id, oli.quantity, oli.backordered_qty, cs.track_inventory
      from public.order_line_items oli
      join public.child_skus cs on cs.id = oli.child_sku_id
     where oli.order_id = p_order_id
     order by oli.id
  loop
    if not r.track_inventory then
      continue;   -- fee line: never reserved, never physically shipped from stock
    end if;

    v_lvl := public._inv_lock(r.child_sku_id);
    if v_lvl.on_hand - r.quantity < 0 then
      raise exception
        'Cannot fulfill cancelled order %: on_hand (%) for SKU % is less than the % unit(s) that shipped',
        p_order_id, v_lvl.on_hand, r.child_sku_id, r.quantity using errcode = 'check_violation';
    end if;

    -- Would this depletion drop on_hand below what's currently reserved by
    -- OTHER open orders for this SKU? Claw the shortfall back from the newest
    -- reservations first (LIFO) instead of refusing to record the shipment.
    v_shortfall := v_lvl.reserved - (v_lvl.on_hand - r.quantity);
    if v_shortfall > 0 then
      for d in
        select oli.id as line_id, oli.order_id, o.order_number,
               (oli.quantity - coalesce(oli.backordered_qty, 0)) as reserved_here
          from public.order_line_items oli
          join public.orders o on o.id = oli.order_id
         where oli.child_sku_id = r.child_sku_id
           and o.id <> p_order_id
           and o.status in ('created', 'picking', 'packed')
           and (oli.quantity - coalesce(oli.backordered_qty, 0)) > 0
         order by o.entered_at desc, oli.id desc
      loop
        exit when v_shortfall <= 0;
        v_take := least(v_shortfall, d.reserved_here);
        perform public.release_stock(r.child_sku_id, v_take, 'order_line_item', d.line_id);
        update public.order_line_items
           set backordered_qty = coalesce(backordered_qty, 0) + v_take
         where id = d.line_id;
        update public.orders set backordered = true where id = d.order_id;
        perform public._inv_write(
          r.child_sku_id, 0, 0, 0, 'correction', 'order', d.order_id,
          format(
            '%s unit(s) demoted to backordered: order %s (reserved this stock after cancelled order %s had already shipped it in ShipStation) — %s',
            v_take, d.order_number, v.order_number, v_reason));
        v_shortfall := v_shortfall - v_take;
      end loop;

      if v_shortfall > 0 then
        raise exception
          'Cannot fulfill cancelled order %: SKU % is short % unit(s) even after backordering every newer open reservation — this needs a physical stock recount, not a backorder shuffle',
          p_order_id, r.child_sku_id, v_shortfall using errcode = 'check_violation';
      end if;
    end if;

    perform public._inv_write(
      r.child_sku_id, -r.quantity, 0, 0, 'cancelled_order_shipped', 'order_line_item', r.id,
      format('Fulfilled cancelled order %s: shipped in ShipStation — %s', v.order_number, v_reason));

    if coalesce(r.backordered_qty, 0) > 0 then
      update public.order_line_items set backordered_qty = 0 where id = r.id;
    end if;
  end loop;

  update public.orders
     set status         = 'fulfilled',
         fulfilled_at   = v_at,
         cancelled_at   = null,
         auto_fulfilled = true,
         backordered    = false
   where id = p_order_id returning * into v;

  update public.fulfillment_groups g set status = 'fulfilled', fulfilled_at = v_at
   where g.id = v.group_id
     and not exists (select 1 from public.orders o where o.group_id = g.id and o.status <> 'fulfilled');
  return v;
end;
$$;

grant execute on function public.fulfill_cancelled_order(uuid, text, timestamptz) to authenticated;

comment on function public.fulfill_cancelled_order is
  'Admin/manager-only correction for an order cancelled in OT that actually shipped (e.g. ShipStation shipped it anyway despite the OT cancellation). Depletes on_hand directly via _inv_write for each inventory-tracked line. If that would drop on_hand below the SKU''s current reserved total, automatically demotes just enough of the NEWEST other open (created/picking/packed) reservations of the same SKU to backordered (release_stock + backordered_qty), on the reasoning that a later reservation on stock this order already shipped should lose out, not this correction — each demotion is written to inventory_ledger as a correction row naming both orders. Raises instead of guessing further if even the newest reservations can''t cover the shortfall (a real physical shortage). Clears any backorder on this order, snapshots COGS, marks it fulfilled + auto_fulfilled, clears cancelled_at, and closes the fulfillment group when its siblings are done. Requires a reason, written to inventory_ledger. Standard orders only. SECURITY DEFINER (reaches the sealed _inv_write/_inv_lock); role gate via app_role().';

commit;
