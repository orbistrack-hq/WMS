-- Rollback for migration 0101. Drops needs_recount_report, restores the 0100
-- function body ('correction' reason for the untracked-units note), and
-- restores the 0099 reason list (drops 'needs_recount').

begin;

drop view if exists public.needs_recount_report;

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
      continue;
    end if;

    v_lvl := public._inv_lock(r.child_sku_id);
    v_deplete   := least(r.quantity, v_lvl.on_hand);
    v_untracked := r.quantity - v_deplete;

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

alter table public.inventory_ledger drop constraint inventory_ledger_reason_check;
alter table public.inventory_ledger add constraint inventory_ledger_reason_check
  check (reason in (
    'order_reserve','order_release','order_consume',
    'layaway_remove','layaway_cancel','layaway_consume',
    'manual_adjustment','receipt','correction',
    'shopify_sync',
    'order_return',
    'transfer_out','transfer_in',
    'cancelled_order_shipped'));

commit;
