-- ============================================================================
-- WMS — Migration 0071: pending_payment order status
--
-- Problem: store orders are imported the moment they're created upstream,
-- regardless of payment. A Woo `pending`/`on-hold` or Shopify
-- `pending`/`authorized` order is unpaid, yet today it lands as `created`,
-- reserves stock, and shows in the working list / packing queue — while
-- ShipStation (which only pulls PAID orders) never sees it. That's the WMS-vs-
-- ShipStation count drift, and it reserves stock for money not yet collected.
--
-- Fix (confirmed with the team): a new terminal-ish holding state
-- `pending_payment`. A held order reserves NO stock and, because the queue/list
-- filter on created/picking/packed, is automatically excluded from work. When
-- the store confirms payment, activate_pending_order() (migration 0072) reserves
-- and promotes it to `created`. A denied/failed payment cancels it as before.
--
-- This migration only widens the status set and teaches the two lifecycle
-- guards about the new state. The create/activate RPCs are migration 0072.
--
-- Reversible: the down migration restores the prior constraint and the 0041
-- forms of cancel_order / set_order_status. (Rolling back with rows still in
-- pending_payment requires moving them out first — an operational note, not a
-- schema concern; the round-trip runs on an empty schema.)
-- ============================================================================

begin;

-- ---- 1. Widen the status set ----------------------------------------------
alter table public.orders drop constraint orders_status_check;
alter table public.orders add constraint orders_status_check
  check (status in
    ('pending_payment','created','picking','packed','fulfilled','cancelled','returned'));

-- ---- 2. cancel_order: don't release stock a held order never reserved ------
-- A pending_payment order reserved nothing, so apply_order_cancellation (which
-- releases quantity - backordered_qty) would corrupt inventory. Skip the
-- inventory step for that one state; every other state is unchanged from 0041.
create or replace function public.cancel_order(p_order_id uuid)
returns public.orders language plpgsql as $$
declare v public.orders;
begin
  select * into v from public.orders where id = p_order_id for update;
  if not found then raise exception 'Order % not found', p_order_id; end if;
  if v.status = 'fulfilled' then raise exception 'Order % is fulfilled and cannot be cancelled', p_order_id; end if;
  if v.status = 'cancelled' then raise exception 'Order % already cancelled', p_order_id; end if;
  if v.status = 'returned' then raise exception 'Order % is returned; re-open it before cancelling', p_order_id; end if;

  -- Held orders never reserved; only release for orders that actually did.
  if v.status <> 'pending_payment' then
    perform public.apply_order_cancellation(p_order_id);
  end if;
  update public.orders set status = 'cancelled', cancelled_at = now() where id = p_order_id returning * into v;
  return v;
end;
$$;

-- ---- 3. set_order_status: never let a held order skip into the pick flow ---
-- A pending_payment order must go through activate_pending_order (which reserves
-- stock) before it can be picked; a bare status move would ship unreserved goods.
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
  if v.status = 'pending_payment' then
    raise exception 'Order % is pending payment; it must be activated (payment cleared) before picking', p_order_id;
  end if;
  update public.orders set status = p_new_status where id = p_order_id returning * into v;
  return v;
end;
$$;

commit;
