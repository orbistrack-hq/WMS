-- ============================================================================
-- WMS — Migration 0007: order lifecycle transitions
--
-- The connective tissue between inventory (0002) and billing (0005). Status
-- 'fulfilled' and 'cancelled' are reachable ONLY through fulfill_order() /
-- cancel_order(), so the inventory and billing side effects can never be
-- skipped by a bare status update. Each locks the order row to serialize.
--
--   set_order_status  created <-> picking <-> packed (no side effects)
--   fulfill_order     consume/clear inventory + snapshot pick fee + mark fulfilled
--   cancel_order      release/return inventory + mark cancelled
-- ============================================================================

begin;

-- Label-only moves. Refuses fulfilled/cancelled (those have side effects).
create or replace function public.set_order_status(p_order_id uuid, p_new_status text)
returns public.orders language plpgsql as $$
declare v public.orders;
begin
  if p_new_status not in ('created','picking','packed') then
    raise exception 'set_order_status handles created/picking/packed only; use fulfill_order() or cancel_order() for %', p_new_status;
  end if;
  select * into v from public.orders where id = p_order_id for update;
  if not found then raise exception 'Order % not found', p_order_id; end if;
  if v.status in ('fulfilled','cancelled') then
    raise exception 'Order % is % and cannot change status', p_order_id, v.status;
  end if;
  update public.orders set status = p_new_status where id = p_order_id returning * into v;
  return v;
end;
$$;

-- Fulfill: inventory consume (standard) or layby clear (layaway), pick-fee
-- snapshot, mark fulfilled. fulfilled_at is set before charging so the fee
-- resolves to the fulfillment date. Atomic: any failure rolls the whole thing back.
create or replace function public.fulfill_order(p_order_id uuid)
returns public.orders language plpgsql as $$
declare v public.orders;
begin
  select * into v from public.orders where id = p_order_id for update;
  if not found then raise exception 'Order % not found', p_order_id; end if;
  if v.status = 'fulfilled' then raise exception 'Order % already fulfilled', p_order_id; end if;
  if v.status = 'cancelled' then raise exception 'Order % is cancelled and cannot be fulfilled', p_order_id; end if;

  update public.orders set status = 'fulfilled', fulfilled_at = now() where id = p_order_id returning * into v;
  perform public.apply_order_fulfillment(p_order_id);   -- inventory
  perform public.charge_order_pick_fee(p_order_id);     -- billing snapshot

  -- close the group once all its orders are fulfilled
  update public.fulfillment_groups g set status = 'fulfilled', fulfilled_at = now()
   where g.id = v.group_id
     and not exists (select 1 from public.orders o where o.group_id = g.id and o.status <> 'fulfilled');
  return v;
end;
$$;

-- Cancel: release reservation (standard) or return layby (layaway), mark cancelled.
create or replace function public.cancel_order(p_order_id uuid)
returns public.orders language plpgsql as $$
declare v public.orders;
begin
  select * into v from public.orders where id = p_order_id for update;
  if not found then raise exception 'Order % not found', p_order_id; end if;
  if v.status = 'fulfilled' then raise exception 'Order % is fulfilled and cannot be cancelled', p_order_id; end if;
  if v.status = 'cancelled' then raise exception 'Order % already cancelled', p_order_id; end if;

  perform public.apply_order_cancellation(p_order_id);  -- inventory
  update public.orders set status = 'cancelled', cancelled_at = now() where id = p_order_id returning * into v;
  return v;
end;
$$;

commit;