-- ============================================================================
-- WMS — Migration 0070: persistent force_fulfilled marker on orders
--
-- WHY. The team wants to see, at a glance, which fulfilled orders were force-
-- fulfilled (shipped while backordered, recorded via force_fulfill_order) versus
-- packed normally. force_fulfill_order leaves an audit row in inventory_ledger,
-- but that's awkward to surface on the orders list. Mirror the auto_fulfilled
-- marker (migration 0063): a plain boolean on the order.
--
-- WHAT.
--   1. orders.force_fulfilled boolean (default false) — the persistent flag.
--   2. force_fulfill_order recreated to set it true on the order it closes.
--      While recreating, two things are carried over / fixed:
--        * SECURITY DEFINER + pinned search_path is re-declared (migration 0067;
--          CREATE OR REPLACE resets unspecified attributes — omitting it would
--          re-break the sealed _inv_write call for non-owner callers).
--        * The reserved-release loop now SKIPS non-inventory (service/fee) lines
--          — the same track_inventory guard migration 0068 added to
--          apply_order_* and fulfill_order_no_stock, but which never reached
--          force_fulfill_order. Without it, force-fulfilling an order that
--          carries a Route "Shipping Protection" line hard-fails in release_stock
--          (reserved < qty, because a fee line is never reserved).
--
-- Additive and fully reversible (see rollback/*.down.sql).
-- ============================================================================

begin;

alter table public.orders
  add column if not exists force_fulfilled boolean not null default false;

comment on column public.orders.force_fulfilled is
  'True when the order was fulfilled via force_fulfill_order (admin/manager override of the backorder guard — shipped while backordered, inventory-neutral). Distinct from auto_fulfilled (store completions). Set only by force_fulfill_order.';

-- Recreate with the marker + the non-inventory guard. SECURITY DEFINER +
-- search_path re-declared (see header / migration 0067).
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
  -- Permission gate: only elevated roles may bypass the backorder guard.
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

  -- COGS basis (mirrors apply_order_fulfillment): freeze current cost, nulls only.
  update public.order_line_items li
     set unit_cost_snapshot = cs.cost
    from public.child_skus cs
   where li.order_id = p_order_id
     and cs.id = li.child_sku_id
     and li.unit_cost_snapshot is null;

  -- Inventory-neutral: give back the reserved portion (as if the order closed),
  -- leave on_hand alone (the shelf is recounted separately), and stamp an audit
  -- row for every line short of stock recording the reason + the shortfall.
  for r in
    select oli.id, oli.child_sku_id, oli.quantity,
           coalesce(oli.backordered_qty, 0) as backordered_qty,
           cs.track_inventory
      from public.order_line_items oli
      join public.child_skus cs on cs.id = oli.child_sku_id
     where oli.order_id = p_order_id
     order by oli.id
  loop
    -- First line of any kind anchors the fallback audit row below.
    if v_first is null then v_first := r.child_sku_id; end if;

    -- Service/fee line (e.g. Route Shipping Protection): never reserved, never
    -- backordered — nothing to release or clear.
    if not r.track_inventory then
      continue;
    end if;

    v_reserved := r.quantity - r.backordered_qty;
    if v_reserved > 0 then
      perform public.release_stock(r.child_sku_id, v_reserved, 'order_line_item', r.id);
    end if;

    v_short := r.backordered_qty;
    if v_short > 0 then
      -- Zero-delta ledger row = pure audit note (no stock change), actor stamped.
      perform public._inv_write(
        r.child_sku_id, 0, 0, 0, 'correction', 'order', p_order_id,
        format('Force fulfill: %s — %s unit(s) shipped without stock', v_reason, v_short));
      update public.order_line_items set backordered_qty = 0 where id = r.id;
      v_any_row := true;
    end if;
  end loop;

  -- Guarantee the reason is captured even if nothing was actually backordered
  -- (force-fulfilling an order that no longer needs it — still record why).
  if not v_any_row and v_first is not null then
    perform public._inv_write(
      v_first, 0, 0, 0, 'correction', 'order', p_order_id,
      format('Force fulfill: %s', v_reason));
  end if;

  update public.orders
     set status = 'fulfilled',
         fulfilled_at = v_at,
         backordered = false,
         force_fulfilled = true
   where id = p_order_id returning * into v;

  -- Locally picked/packed, so it earns the pick fee (unlike store completions).
  perform public.charge_order_pick_fee(p_order_id);

  update public.fulfillment_groups g set status = 'fulfilled', fulfilled_at = v_at
   where g.id = v.group_id
     and not exists (select 1 from public.orders o where o.group_id = g.id and o.status <> 'fulfilled');
  return v;
end;
$$;

grant execute on function public.force_fulfill_order(uuid, text, timestamptz) to authenticated;

comment on function public.force_fulfill_order is
  'Admin/manager-only, inventory-neutral override of the backorder fulfillment guard: releases each inventory line''s reserved portion (skips service/fee lines), leaves on_hand untouched, clears the backorder, snapshots COGS, charges the pick fee, marks the order fulfilled + force_fulfilled. Requires a reason, written to inventory_ledger as a correction row. Standard orders only. SECURITY DEFINER (reaches the sealed _inv_write); role gate via app_role().';

commit;
