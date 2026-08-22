-- ============================================================================
-- WMS — Migration 0101: needs_recount_report
--
-- WHY. Migration 0100 taught fulfill_cancelled_order to clamp on_hand at zero
-- and write a note instead of blocking when a SKU is already fully depleted —
-- but that note (reason 'correction', buried in inventory_ledger) was only
-- ever visible one SKU at a time on /inventory/{id}. There was no way to see,
-- across the whole catalog, which SKUs currently have an outstanding "this
-- couldn't be reflected in on_hand — needs a physical recount" flag.
--
-- WHAT.
--   1. A distinct ledger reason 'needs_recount', so this flag is queryable
--      without fragile note-text matching (extends inventory_ledger_reason_check,
--      last set in migration 0099). fulfill_cancelled_order (migration 0100)
--      recreated here using 'needs_recount' instead of 'correction' for that
--      one note — no other behavior changes.
--   2. needs_recount_report — one row per flagged ledger entry, joined to the
--      SKU/product/site for display. security_invoker so site scoping applies,
--      same as backorder_report / orders_missing_packaging. No "resolved" state
--      tracked (this is meant to be rare): a recount is expected to close the
--      gap via a manual_adjustment on the same SKU, visible in that SKU's own
--      ledger history on /inventory/{id} for context.
-- ============================================================================

begin;

-- ---- 1. Ledger reason -------------------------------------------------------
alter table public.inventory_ledger drop constraint inventory_ledger_reason_check;
alter table public.inventory_ledger add constraint inventory_ledger_reason_check
  check (reason in (
    'order_reserve','order_release','order_consume',
    'layaway_remove','layaway_cancel','layaway_consume',
    'manual_adjustment','receipt','correction',
    'shopify_sync',
    'order_return',
    'transfer_out','transfer_in',
    'cancelled_order_shipped','needs_recount'));

-- ---- 2. fulfill_cancelled_order: use 'needs_recount' for the untracked note -
create or replace function public.fulfill_cancelled_order(
  p_order_id     uuid,
  p_reason       text,
  p_fulfilled_at timestamptz default null
)
returns public.orders
language plpgsql security definer set search_path = '' as $$
declare
  v           public.orders;
  v_at        timestamptz := coalesce(p_fulfilled_at, now());
  v_reason    text := nullif(trim(coalesce(p_reason, '')), '');
  r           record;
  d           record;
  v_lvl       public.inventory_levels;
  v_deplete   integer;
  v_untracked integer;
  v_shortfall integer;
  v_take      integer;
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
      continue;
    end if;

    v_lvl := public._inv_lock(r.child_sku_id);
    v_deplete   := least(r.quantity, v_lvl.on_hand);
    v_untracked := r.quantity - v_deplete;

    v_shortfall := v_lvl.reserved - (v_lvl.on_hand - v_deplete);
    if v_shortfall > 0 then
      for d in
        select oli.id as line_id, oli.order_id, o.order_number,
               (oli.quantity - coalesce(oli.backordered_qty, 0)) as reserved_here
          from public.order_line_items oli
          join public.orders o on o.id = oli.order_id
         where oli.child_sku_id = r.child_sku_id
           and o.id <> p_order_id
           and o.status in ('created', 'picking', 'packed')
           and (oli.quantity - coalesce(oli.backordered_qty, 0)) > 0
         order by o.entered_at desc, oli.id desc
      loop
        exit when v_shortfall <= 0;
        v_take := least(v_shortfall, d.reserved_here);
        perform public.release_stock(r.child_sku_id, v_take, 'order_line_item', d.line_id);
        update public.order_line_items
           set backordered_qty = coalesce(backordered_qty, 0) + v_take
         where id = d.line_id;
        update public.orders set backordered = true where id = d.order_id;
        perform public._inv_write(
          r.child_sku_id, 0, 0, 0, 'correction', 'order', d.order_id,
          format(
            '%s unit(s) demoted to backordered: order %s (reserved this stock after cancelled order %s had already shipped it in ShipStation) — %s',
            v_take, d.order_number, v.order_number, v_reason));
        v_shortfall := v_shortfall - v_take;
      end loop;

      if v_shortfall > 0 then
        raise exception
          'Cannot fulfill cancelled order %: SKU % is short % unit(s) even after backordering every newer open reservation — this needs a physical stock recount, not a backorder shuffle',
          p_order_id, r.child_sku_id, v_shortfall using errcode = 'check_violation';
      end if;
    end if;

    if v_deplete > 0 then
      perform public._inv_write(
        r.child_sku_id, -v_deplete, 0, 0, 'cancelled_order_shipped', 'order_line_item', r.id,
        format('Fulfilled cancelled order %s: shipped in ShipStation — %s', v.order_number, v_reason));
    end if;
    if v_untracked > 0 then
      perform public._inv_write(
        r.child_sku_id, 0, 0, 0, 'needs_recount', 'order_line_item', r.id,
        format(
          '%s unit(s) of order %s''s shipment could not be reflected in on_hand (already at 0) — SKU needs a physical recount: %s',
          v_untracked, v.order_number, v_reason));
    end if;

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
  'Admin/manager-only correction for an order cancelled in OT that actually shipped (e.g. ShipStation shipped it anyway despite the OT cancellation). Depletes on_hand directly for each inventory-tracked line, clamped so on_hand never goes negative — any quantity that does not fit gets a ''needs_recount'' ledger note (see needs_recount_report) instead of blocking. If depleting the fitting portion would drop on_hand below the SKU''s current reserved total, automatically demotes just enough of the NEWEST other open (created/picking/packed) reservations of the same SKU to backordered — each demotion audited in inventory_ledger naming both orders. Raises only if even the newest reservations cannot cover that shortfall. Clears any backorder on this order, snapshots COGS, marks it fulfilled + auto_fulfilled, clears cancelled_at, and closes the fulfillment group when its siblings are done. Requires a reason, written to inventory_ledger. Standard orders only. SECURITY DEFINER (reaches the sealed _inv_write/_inv_lock); role gate via app_role().';

-- ---- 3. needs_recount_report -------------------------------------------------
create view public.needs_recount_report with (security_invoker = true) as
select
  il.id            as ledger_id,
  il.child_sku_id,
  cs.sku,
  cs.site_id,
  s.name           as site_name,
  p.name           as product_name,
  il.note,
  il.created_at
from public.inventory_ledger il
join public.child_skus cs on cs.id = il.child_sku_id
join public.products p    on p.id = cs.product_id
join public.sites s       on s.id = cs.site_id
where il.reason = 'needs_recount'
order by il.created_at desc;

grant select on public.needs_recount_report to authenticated;

comment on view public.needs_recount_report is
  'One row per ''needs_recount'' inventory_ledger entry — a unit fulfill_cancelled_order could not reflect in on_hand because the SKU was already at zero. No resolved-state tracking (expected to be rare); a recount is expected to close the gap via a manual_adjustment on the same SKU, visible in that SKU''s own ledger history on /inventory/{id}.';

commit;
