-- ============================================================================
-- Rollback 0041: remove order returns.
--
-- Restores the post-0040 state:
--   * drop returns_report + the return_order / reopen_order / apply_order_return
--     / return_stock functions;
--   * restore set_order_status, cancel_order (0007 bodies) and fulfill_order
--     (0028 body) without the 'returned' guard;
--   * drop the 'order_return' ledger reason, the 'returned' order status, and
--     the returned_at column.
-- Assumes no rows are in status 'returned' (as after a clean feature rollback).
-- ============================================================================

begin;

drop view if exists public.returns_report;

drop function if exists public.return_order(uuid);
drop function if exists public.reopen_order(uuid);
drop function if exists public.apply_order_return(uuid);
drop function if exists public.return_stock(uuid,integer,text,uuid,text);

-- ---- restore set_order_status (0007 body) ----------------------------------
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

-- ---- restore fulfill_order (0028 body) -------------------------------------
create or replace function public.fulfill_order(
  p_order_id     uuid,
  p_fulfilled_at timestamptz default null
)
returns public.orders language plpgsql as $$
declare
  v    public.orders;
  v_at timestamptz := coalesce(p_fulfilled_at, now());
begin
  select * into v from public.orders where id = p_order_id for update;
  if not found then raise exception 'Order % not found', p_order_id; end if;
  if v.status = 'fulfilled' then raise exception 'Order % already fulfilled', p_order_id; end if;
  if v.status = 'cancelled' then raise exception 'Order % is cancelled and cannot be fulfilled', p_order_id; end if;

  update public.orders set status = 'fulfilled', fulfilled_at = v_at
   where id = p_order_id returning * into v;
  perform public.apply_order_fulfillment(p_order_id);
  perform public.charge_order_pick_fee(p_order_id);

  update public.fulfillment_groups g set status = 'fulfilled', fulfilled_at = v_at
   where g.id = v.group_id
     and not exists (select 1 from public.orders o where o.group_id = g.id and o.status <> 'fulfilled');
  return v;
end;
$$;

-- ---- restore cancel_order (0007 body) --------------------------------------
create or replace function public.cancel_order(p_order_id uuid)
returns public.orders language plpgsql as $$
declare v public.orders;
begin
  select * into v from public.orders where id = p_order_id for update;
  if not found then raise exception 'Order % not found', p_order_id; end if;
  if v.status = 'fulfilled' then raise exception 'Order % is fulfilled and cannot be cancelled', p_order_id; end if;
  if v.status = 'cancelled' then raise exception 'Order % already cancelled', p_order_id; end if;

  perform public.apply_order_cancellation(p_order_id);
  update public.orders set status = 'cancelled', cancelled_at = now() where id = p_order_id returning * into v;
  return v;
end;
$$;

-- ---- drop the ledger reason, status value, and column ----------------------
-- Restore the post-0040 constraint: this is the 0017 list (which includes
-- 'shopify_sync'), NOT the original 0002 list. Omitting 'shopify_sync' here
-- would make the rollback fail on existing store-sync rows.
alter table public.inventory_ledger drop constraint inventory_ledger_reason_check;
alter table public.inventory_ledger add constraint inventory_ledger_reason_check
  check (reason in (
    'order_reserve','order_release','order_consume',
    'layaway_remove','layaway_cancel','layaway_consume',
    'manual_adjustment','receipt','correction','shopify_sync'));

alter table public.orders drop constraint orders_status_check;
alter table public.orders add constraint orders_status_check
  check (status in ('created','picking','packed','fulfilled','cancelled'));
alter table public.orders drop column if exists returned_at;

commit;
