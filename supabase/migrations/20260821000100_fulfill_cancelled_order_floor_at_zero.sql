-- ============================================================================
-- WMS — Migration 0100: fulfill_cancelled_order — clamp on_hand at zero
--
-- WHY. Migration 0098 auto-resolves a shortfall between this order's shipment
-- and OTHER orders' current reservations (by backordering the newest of them —
-- stock still physically exists, it's just double-promised). But on_hand also
-- has its own hard floor (`check (on_hand >= 0)`, migration 0001), and that
-- case is fundamentally different: if on_hand is ALREADY 0, there is no
-- reservation to reclaim — demoting another order's reservation doesn't
-- conjure physical stock. It means every unit of this SKU OT ever counted has
-- already left through normal fulfillment, and this order's unit shipped on
-- top of that, from stock OT's on_hand never tracked at all. That's not
-- something a backorder shuffle can fix; on_hand simply cannot be pushed
-- negative to represent it (confirmed with the team: proceed anyway, clamp at
-- zero, and flag it — don't block the correction on a recount).
--
-- WHAT. Clamp the on_hand depletion at on_hand's current floor (never write
-- past 0). Whatever quantity doesn't fit gets a zero-delta 'correction' ledger
-- note instead — naming the order and the untracked unit count — so the SKU
-- surfaces for a physical recount without blocking this order's correction.
-- The existing newer-reservation backorder logic (0098) still runs against
-- whatever portion IS actually depleted, unchanged.
--
-- No signature change. Rollback restores the 0098 body (raises immediately
-- instead of clamping when on_hand can't cover the full shipped quantity).
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
  v           public.orders;
  v_at        timestamptz := coalesce(p_fulfilled_at, now());
  v_reason    text := nullif(trim(coalesce(p_reason, '')), '');
  r           record;
  d           record;
  v_lvl       public.inventory_levels;
  v_deplete   integer;
  v_untracked integer;
  v_shortfall integer;
  v_take      integer;
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
    -- Clamp at zero: on_hand can never go negative. Whatever doesn't fit is
    -- "untracked" — shipped from stock OT never counted, not something a
    -- write to this SKU can fix.
    v_deplete   := least(r.quantity, v_lvl.on_hand);
    v_untracked := r.quantity - v_deplete;

    -- Would depleting the fitting portion drop on_hand below what's currently
    -- reserved by OTHER open orders for this SKU? Claw the shortfall back from
    -- the newest reservations first (LIFO) instead of refusing to record it.
    v_shortfall := v_lvl.reserved - (v_lvl.on_hand - v_deplete);
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

    if v_deplete > 0 then
      perform public._inv_write(
        r.child_sku_id, -v_deplete, 0, 0, 'cancelled_order_shipped', 'order_line_item', r.id,
        format('Fulfilled cancelled order %s: shipped in ShipStation — %s', v.order_number, v_reason));
    end if;
    if v_untracked > 0 then
      perform public._inv_write(
        r.child_sku_id, 0, 0, 0, 'correction', 'order_line_item', r.id,
        format(
          '%s unit(s) of order %s''s shipment could not be reflected in on_hand (already at 0) — SKU needs a physical recount: %s',
          v_untracked, v.order_number, v_reason));
    end if;

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
  'Admin/manager-only correction for an order cancelled in OT that actually shipped (e.g. ShipStation shipped it anyway despite the OT cancellation). Depletes on_hand directly for each inventory-tracked line, clamped so on_hand never goes negative — any quantity that does not fit gets a zero-delta ''correction'' ledger note flagging the SKU for a physical recount instead of blocking. If depleting the fitting portion would drop on_hand below the SKU''s current reserved total, automatically demotes just enough of the NEWEST other open (created/picking/packed) reservations of the same SKU to backordered (release_stock + backordered_qty) — each demotion audited in inventory_ledger naming both orders. Raises only if even the newest reservations cannot cover that shortfall. Clears any backorder on this order, snapshots COGS, marks it fulfilled + auto_fulfilled, clears cancelled_at, and closes the fulfillment group when its siblings are done. Requires a reason, written to inventory_ledger. Standard orders only. SECURITY DEFINER (reaches the sealed _inv_write/_inv_lock); role gate via app_role().';

commit;
