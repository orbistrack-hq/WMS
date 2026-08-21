-- ============================================================================
-- WMS — Migration 0095: fulfill_cancelled_order (cancelled-but-actually-shipped)
--
-- WHY. WooCommerce/Shopify orders that get cancelled in OT sometimes still ship
-- from ShipStation anyway. WMS deliberately never reopens a cancelled order from
-- a later store webhook (lib/woocommerce/import-orders.ts: "store-side
-- completed/cancelled wins, forward-only"), so these sit stuck as cancelled
-- while ShipStation shows them shipped — the /integrations/shipstation
-- reconcile screen's "shipped in ShipStation, not fulfilled in OT" row, noted
-- "OT cancelled". Every existing fulfillment RPC (fulfill_order,
-- fulfill_order_no_stock, force_fulfill_order) explicitly refuses a cancelled
-- order, so there was no way to correct these (found via the fulfillment team
-- flagging several WOO- orders in this exact state).
--
-- WHAT. fulfill_cancelled_order(order, reason, fulfilled_at) — admin/manager-
-- only, for orders currently 'cancelled':
--   * cancel_order already released each inventory line's reservation via
--     release_stock, and never touched on_hand — so on_hand is currently
--     overstated by whatever actually shipped. This depletes on_hand directly
--     via adjust_stock (guarded against going negative or below what other
--     orders still have reserved), NOT consume_stock — consume_stock also
--     decrements `reserved`, and there is no reservation left on this order to
--     decrement (release_stock already zeroed it out at cancel time). Skips
--     non-inventory (service/fee) lines, same as the other fulfillment RPCs.
--   * clears backordered_qty / orders.backordered (moot — it already shipped);
--   * snapshots COGS (nulls only), same as apply_order_fulfillment;
--   * requires a reason, which lands in inventory_ledger via adjust_stock's own
--     note — no direct _inv_write call needed, so unlike force_fulfill_order
--     this function does not need SECURITY DEFINER;
--   * marks the order fulfilled + auto_fulfilled (a store-side completion, not
--     one packed locally — no pick fee, mirroring fulfill_order_no_stock),
--     fulfilled_at back-datable to the real ship date, clears cancelled_at;
--   * closes the fulfillment group once every sibling order is fulfilled.
-- Standard orders only — layaway has its own booking lifecycle.
--
-- Net-new; the rollback drops it.
-- ============================================================================

begin;

create or replace function public.fulfill_cancelled_order(
  p_order_id     uuid,
  p_reason       text,
  p_fulfilled_at timestamptz default null
)
returns public.orders language plpgsql as $$
declare
  v        public.orders;
  v_at     timestamptz := coalesce(p_fulfilled_at, now());
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  r        record;
begin
  -- Permission gate: only elevated roles may un-cancel and fulfill an order.
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
    perform public.adjust_stock(
      r.child_sku_id, -r.quantity,
      format('Fulfilled cancelled order %s: shipped in ShipStation — %s', v.order_number, v_reason),
      'order_line_item', r.id);
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
  'Admin/manager-only correction for an order cancelled in OT that actually shipped (e.g. ShipStation shipped it anyway despite the OT cancellation). cancel_order already released the reservation and never touched on_hand, so this depletes on_hand directly via adjust_stock (guarded against going negative or below what other orders have reserved) for each inventory-tracked line, clears any backorder, snapshots COGS, marks the order fulfilled + auto_fulfilled, clears cancelled_at, and closes the fulfillment group when its siblings are done. Requires a reason, written to inventory_ledger via adjust_stock''s note. Standard orders only.';

commit;
