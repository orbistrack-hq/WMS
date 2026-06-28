-- Rollback 0028: restore the original one-arg fulfill_order(uuid).
-- NOTE: any orders.order_number values rewritten to "SHOP-..." by the importer
-- are left as-is (a label change, harmless to keep).

begin;

drop function if exists public.fulfill_order(uuid, timestamptz);

create or replace function public.fulfill_order(p_order_id uuid)
returns public.orders language plpgsql as $$
declare v public.orders;
begin
  select * into v from public.orders where id = p_order_id for update;
  if not found then raise exception 'Order % not found', p_order_id; end if;
  if v.status = 'fulfilled' then raise exception 'Order % already fulfilled', p_order_id; end if;
  if v.status = 'cancelled' then raise exception 'Order % is cancelled and cannot be fulfilled', p_order_id; end if;

  update public.orders set status = 'fulfilled', fulfilled_at = now() where id = p_order_id returning * into v;
  perform public.apply_order_fulfillment(p_order_id);
  perform public.charge_order_pick_fee(p_order_id);

  update public.fulfillment_groups g set status = 'fulfilled', fulfilled_at = now()
   where g.id = v.group_id
     and not exists (select 1 from public.orders o where o.group_id = g.id and o.status <> 'fulfilled');
  return v;
end;
$$;

grant execute on function public.fulfill_order(uuid) to authenticated;

commit;
