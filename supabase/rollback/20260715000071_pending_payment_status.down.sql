-- Down: migration 0071 (pending_payment order status)
-- Restores the 0041 forms of cancel_order / set_order_status and the prior
-- status constraint. NOTE: any rows still in 'pending_payment' must be moved to
-- another status before this runs, or the constraint re-add will fail.

begin;

-- ---- 3. set_order_status back to the 0041 form ----------------------------
create or replace function public.set_order_status(p_order_id uuid, p_new_status text)
returns public.orders language plpgsql as $$
declare v public.orders;
begin
  if p_new_status not in ('created','picking','packed') then
    raise exception 'set_order_status handles created/picking/packed only; use fulfill_order() or cancel_order() for %', p_new_status;
  end if;
  select * into v from public.orders where id = p_order_id for update;
  if not found then raise exception 'Order % not found', p_order_id; end if;
  if v.status in ('fulfilled','cancelled','returned') then
    raise exception 'Order % is % and cannot change status', p_order_id, v.status;
  end if;
  update public.orders set status = p_new_status where id = p_order_id returning * into v;
  return v;
end;
$$;

-- ---- 2. cancel_order back to the 0041 form --------------------------------
create or replace function public.cancel_order(p_order_id uuid)
returns public.orders language plpgsql as $$
declare v public.orders;
begin
  select * into v from public.orders where id = p_order_id for update;
  if not found then raise exception 'Order % not found', p_order_id; end if;
  if v.status = 'fulfilled' then raise exception 'Order % is fulfilled and cannot be cancelled', p_order_id; end if;
  if v.status = 'cancelled' then raise exception 'Order % already cancelled', p_order_id; end if;
  if v.status = 'returned' then raise exception 'Order % is returned; re-open it before cancelling', p_order_id; end if;

  perform public.apply_order_cancellation(p_order_id);
  update public.orders set status = 'cancelled', cancelled_at = now() where id = p_order_id returning * into v;
  return v;
end;
$$;

-- ---- 1. Narrow the status set back ----------------------------------------
alter table public.orders drop constraint orders_status_check;
alter table public.orders add constraint orders_status_check
  check (status in
    ('created','picking','packed','fulfilled','cancelled','returned'));

commit;
