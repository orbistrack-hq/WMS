-- ============================================================================
-- WMS — Migration 0066: force_fulfill_order + backorder_report
--
-- WHY. Two connected gaps the fulfillment team hit reconciling orders that
-- physically shipped while still flagged backordered:
--   1. apply_order_fulfillment BLOCKS fulfillment while any line is backordered
--      ("you can't ship what you never reserved"). Correct as a default guard —
--      but the team sometimes ships an order before the shelf is reconciled and
--      needs to RECORD that it went out, without lying about stock or driving
--      on_hand negative.
--   2. There is no single place to see HOW MUCH is owed on backorder per SKU /
--      per order, so ops can't tell how short they are before recounting.
--
-- WHAT.
--   A. force_fulfill_order(order, reason, fulfilled_at) — a guarded, INVENTORY-
--      NEUTRAL override of the backorder block:
--        * admin/manager ONLY (plain operators cannot bypass the guard);
--        * requires a non-empty reason, which is written to the inventory_ledger
--          as an auditable 'correction' row (actor = auth.uid()) alongside the
--          number of units shipped without stock — the change log the team asked
--          for;
--        * RELEASES the reserved portion of each line (quantity - backordered_qty)
--          and does NOT consume on_hand — the team recounts + resets on-hand as a
--          separate step, so touching on_hand here would just be churn the recount
--          overwrites (this is the behavior confirmed with the team);
--        * clears backordered_qty + the orders.backordered flag (we are recording
--          a shipment, not still owing stock);
--        * snapshots COGS (nulls only) so margin reports keep a cost basis;
--        * marks the order fulfilled (backdate-able) and charges the pick fee —
--          unlike fulfill_order_no_stock (store completions that skipped local
--          packing), a force-fulfilled order WAS picked/packed locally, so it is
--          NOT auto_fulfilled and it DOES earn the pick fee.
--      Contrast with the neighbours:
--        fulfill_order          — normal path; consumes on_hand; blocked on backorder.
--        fulfill_order_no_stock — store completions; releases reservation, no fee,
--                                 auto_fulfilled, no reason/audit, no gate.
--        force_fulfill_order    — local override; releases reservation, charges fee,
--                                 NOT auto_fulfilled, REQUIRES reason + audit + gate.
--      Standard orders only — layaway has its own booking lifecycle.
--
--   B. backorder_report — a security_invoker view (site-scoped by RLS, like
--      orders_missing_packaging) with one row per OPEN standard order line that
--      still has backordered_qty > 0, carrying the order, SKU, and a snapshot of
--      current on_hand/reserved/available so the report can roll up "units owed"
--      per SKU and drill to the affected orders.
--
-- Both objects are net-new; the rollback simply drops them.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- A. force_fulfill_order — inventory-neutral, audited, admin/manager-gated.
-- ----------------------------------------------------------------------------
create or replace function public.force_fulfill_order(
  p_order_id     uuid,
  p_reason       text,
  p_fulfilled_at timestamptz default null
)
returns public.orders language plpgsql as $$
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
         backordered = false
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
  'Admin/manager-only, inventory-neutral override of the backorder fulfillment guard: releases each line''s reserved portion, leaves on_hand untouched (recounted separately), clears the backorder, snapshots COGS, charges the pick fee, and marks the order fulfilled (backdate-able). Requires a reason, which is written to inventory_ledger as a correction row with the number of units shipped without stock. Standard orders only. Use to record a backordered order that physically shipped; the normal path stays fulfill_order.';

-- ----------------------------------------------------------------------------
-- B. backorder_report — open backordered lines with a live stock snapshot.
--    security_invoker so the caller's RLS site-scoping applies (managers/ops
--    see every site; clients see only theirs), matching orders_missing_packaging.
-- ----------------------------------------------------------------------------
create or replace view public.backorder_report with (security_invoker = true) as
select
  li.id                                            as line_id,
  o.id                                             as order_id,
  o.order_number,
  o.site_id,
  s.name                                           as site_name,
  o.channel,
  o.order_type,
  o.status,
  o.on_hold,
  o.entered_at,
  o.sale_date,
  o.customer_id,
  c.name                                           as customer_name,
  li.child_sku_id,
  cs.sku,
  cs.product_id,
  p.name                                           as product_name,
  li.quantity                                      as ordered_qty,
  (li.quantity - coalesce(li.backordered_qty, 0))  as reserved_qty,
  li.backordered_qty                               as backordered_qty,
  coalesce(il.on_hand, 0)                          as on_hand,
  coalesce(il.reserved, 0)                         as reserved_total,
  (coalesce(il.on_hand, 0) - coalesce(il.reserved, 0)) as available
from public.order_line_items li
join public.orders o        on o.id = li.order_id
join public.child_skus cs   on cs.id = li.child_sku_id
join public.products p       on p.id = cs.product_id
join public.sites s          on s.id = o.site_id
left join public.customers c on c.id = o.customer_id
left join public.inventory_levels il on il.child_sku_id = li.child_sku_id
where coalesce(li.backordered_qty, 0) > 0
  and o.order_type = 'standard'
  and o.status not in ('fulfilled', 'cancelled', 'returned');

grant select on public.backorder_report to authenticated;

comment on view public.backorder_report is
  'One row per open standard order line still awaiting stock (backordered_qty > 0), with a live on_hand/reserved/available snapshot for the SKU. Roll up backordered_qty per child_sku_id for "units owed", or list per order to drill in. security_invoker: site-scoped by the caller''s RLS.';

commit;
