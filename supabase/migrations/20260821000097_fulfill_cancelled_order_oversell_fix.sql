-- ============================================================================
-- WMS — Migration 0097: fulfill_cancelled_order — stop guarding on reserved
--
-- BUG. fulfill_cancelled_order (migration 0095) depleted on_hand via
-- adjust_stock, which refuses to drop on_hand below what's currently reserved
-- ("Adjustment would drop on_hand below reserved for %: reserved %, new
-- on_hand %"). That guard is right for a DISCRETIONARY manual correction (an
-- operator eyeballing a recount shouldn't accidentally promise stock to a
-- reservation that isn't there) — but it's wrong here.
--
-- Here's why it fires at all: cancel_order released this order's reservation
-- back to the pool (assuming, at the time, that the stock was genuinely free).
-- If some OTHER order reserved that freed stock before we run this correction,
-- on_hand is now honestly too low to cover both that reservation AND the units
-- that already physically left via ShipStation — a real oversell, CAUSED by
-- the original wrong cancellation, not a bug in this function. Refusing the
-- write doesn't fix that oversell; it just hides it by leaving on_hand
-- artificially inflated, which is worse. The other order's shortfall is a
-- separate, real problem for a human to resolve (recount, expedite, or
-- backorder it) — not something this correction should silently paper over by
-- refusing to record that the units are gone.
--
-- FIX. Stop calling adjust_stock. Deplete on_hand directly via _inv_write
-- (delta_reserved = 0 — this order's reservation is already gone, there's
-- nothing left to release), keeping only the floor that actually matters: never
-- let on_hand go negative (that would mean on_hand was already impossibly low
-- for what shipped — a deeper data problem worth stopping for, not something
-- to force through). Distinct ledger reason 'cancelled_order_shipped' so this
-- correction is easy to find/audit separately from normal packing consumption.
--
-- Calling _inv_write directly (rather than through the adjust_stock/
-- consume_stock wrappers, which are all already SECURITY DEFINER) means this
-- function itself now needs SECURITY DEFINER + a pinned search_path — the same
-- fix migration 0067 applied to force_fulfill_order for the identical reason.
--
-- No signature change; same guards/permission gate/COGS/backorder-clear/group-
-- close logic as 0095, only the inventory-write step changes. Rollback restores
-- the 0095 body (adjust_stock, INVOKER).
-- ============================================================================

begin;

create or replace function public.fulfill_cancelled_order(
  p_order_id     uuid,
  p_reason       text,
  p_fulfilled_at timestamptz default null
)
returns public.orders
language plpgsql security definer set search_path = '' as $$
declare
  v        public.orders;
  v_at     timestamptz := coalesce(p_fulfilled_at, now());
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  r        record;
  v_lvl    public.inventory_levels;
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

  -- COGS basis (mirrors apply_order_fulfillment): freeze current cost, nulls only.
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
      continue;   -- fee line: never reserved, never physically shipped from stock
    end if;

    v_lvl := public._inv_lock(r.child_sku_id);
    if v_lvl.on_hand - r.quantity < 0 then
      raise exception
        'Cannot fulfill cancelled order %: on_hand (%) for SKU % is less than the % unit(s) that shipped',
        p_order_id, v_lvl.on_hand, r.child_sku_id, r.quantity using errcode = 'check_violation';
    end if;
    perform public._inv_write(
      r.child_sku_id, -r.quantity, 0, 0, 'cancelled_order_shipped', 'order_line_item', r.id,
      format('Fulfilled cancelled order %s: shipped in ShipStation — %s', v.order_number, v_reason));

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

comment on function public.fulfill_cancelled_order is
  'Admin/manager-only correction for an order cancelled in OT that actually shipped (e.g. ShipStation shipped it anyway despite the OT cancellation). Depletes on_hand directly via _inv_write for each inventory-tracked line (NOT adjust_stock: this order''s reservation is already gone, and on_hand is allowed to drop below what other orders have reserved — that reflects a real oversell the original cancellation caused, not something to hide by refusing the write; on_hand is still never allowed to go negative). Clears any backorder, snapshots COGS, marks the order fulfilled + auto_fulfilled, clears cancelled_at, and closes the fulfillment group when its siblings are done. Requires a reason, written to inventory_ledger with reason ''cancelled_order_shipped''. Standard orders only. SECURITY DEFINER (reaches the sealed _inv_write/_inv_lock); role gate via app_role().';

commit;
