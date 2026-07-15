-- ============================================================================
-- Rollback 0070 — remove the force_fulfilled marker.
-- Restores force_fulfill_order to its pre-0070 state (migration 0066 body with
-- the 0067 SECURITY DEFINER + search_path), i.e. WITHOUT setting force_fulfilled
-- and WITHOUT the non-inventory guard, then drops the column. Recreate the
-- function first so it no longer references the column being dropped.
-- (Note: reverting reintroduces the pre-0070 gap where force-fulfilling an order
-- with a service/fee line fails in release_stock — reversal restores prior state
-- by definition; it is only for a clean migration round-trip.)
-- ============================================================================

begin;

create or replace function public.force_fulfill_order(
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
  v_reserved integer;
  v_short    integer;
  v_any_row  boolean := false;
  v_first    uuid;
begin
  if public.app_role() not in ('admin', 'manager') then
    raise exception 'force_fulfill_order requires the admin or manager role'
      using errcode = 'insufficient_privilege';
  end if;
  if v_reason is null then
    raise exception 'force_fulfill_order requires a reason (it is written to the audit log)';
  end if;

  select * into v from public.orders where id = p_order_id for update;
  if not found then raise exception 'Order % not found', p_order_id; end if;
  if v.status = 'fulfilled' then raise exception 'Order % already fulfilled', p_order_id; end if;
  if v.status = 'cancelled' then raise exception 'Order % is cancelled and cannot be fulfilled', p_order_id; end if;
  if v.status = 'returned' then raise exception 'Order % is returned; re-open it before fulfilling', p_order_id; end if;
  if v.order_type <> 'standard' then
    raise exception 'force_fulfill_order is for standard orders only (order % is %)', p_order_id, v.order_type;
  end if;

  update public.order_line_items li
     set unit_cost_snapshot = cs.cost
    from public.child_skus cs
   where li.order_id = p_order_id
     and cs.id = li.child_sku_id
     and li.unit_cost_snapshot is null;

  for r in
    select id, child_sku_id, quantity, coalesce(backordered_qty, 0) as backordered_qty
      from public.order_line_items where order_id = p_order_id
     order by id
  loop
    if v_first is null then v_first := r.child_sku_id; end if;

    v_reserved := r.quantity - r.backordered_qty;
    if v_reserved > 0 then
      perform public.release_stock(r.child_sku_id, v_reserved, 'order_line_item', r.id);
    end if;

    v_short := r.backordered_qty;
    if v_short > 0 then
      perform public._inv_write(
        r.child_sku_id, 0, 0, 0, 'correction', 'order', p_order_id,
        format('Force fulfill: %s — %s unit(s) shipped without stock', v_reason, v_short));
      update public.order_line_items set backordered_qty = 0 where id = r.id;
      v_any_row := true;
    end if;
  end loop;

  if not v_any_row and v_first is not null then
    perform public._inv_write(
      v_first, 0, 0, 0, 'correction', 'order', p_order_id,
      format('Force fulfill: %s', v_reason));
  end if;

  update public.orders
     set status = 'fulfilled',
         fulfilled_at = v_at,
         backordered = false
   where id = p_order_id returning * into v;

  perform public.charge_order_pick_fee(p_order_id);

  update public.fulfillment_groups g set status = 'fulfilled', fulfilled_at = v_at
   where g.id = v.group_id
     and not exists (select 1 from public.orders o where o.group_id = g.id and o.status <> 'fulfilled');
  return v;
end;
$$;

grant execute on function public.force_fulfill_order(uuid, text, timestamptz) to authenticated;

alter table public.orders drop column if exists force_fulfilled;

commit;
