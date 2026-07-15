-- ============================================================================
-- WMS — Migration 0073: demote_to_pending_payment (backfill helper)
--
-- Before 0071/0072, unpaid store orders were imported as `created` and reserved
-- stock. This RPC lets the one-time sweep (scripts/hold-unpaid-orders.mjs) move
-- such an order back to `pending_payment` and RELEASE its reservation through
-- the inventory state machine — never a raw status update, which would strand
-- the reserved units.
--
-- Guarded: only a freshly-created standard order (never picked/packed) can be
-- demoted. A picked/packed/fulfilled order is left alone — the team is already
-- working it, so payment is moot.
-- ============================================================================

begin;

create or replace function public.demote_to_pending_payment(p_order_id uuid)
returns public.orders language plpgsql as $$
declare v public.orders;
begin
  select * into v from public.orders where id = p_order_id for update;
  if not found then raise exception 'Order % not found', p_order_id; end if;
  if v.status <> 'created' then
    raise exception 'Order % is % — only a created order can be held for payment', p_order_id, v.status;
  end if;
  if v.order_type <> 'standard' then
    raise exception 'Order % is % — only standard orders hold for payment', p_order_id, v.order_type;
  end if;

  -- Return the reserved portion (quantity - backordered_qty per line) to the
  -- shelf, then clear backorder bookkeeping and flip to pending_payment. The
  -- units will be reserved again if/when activate_pending_order runs at payment.
  perform public.apply_order_cancellation(p_order_id);
  update public.order_line_items set backordered_qty = 0 where order_id = p_order_id;
  update public.orders set status = 'pending_payment', backordered = false
    where id = p_order_id returning * into v;
  return v;
end;
$$;

grant execute on function public.demote_to_pending_payment(uuid) to authenticated;

commit;
