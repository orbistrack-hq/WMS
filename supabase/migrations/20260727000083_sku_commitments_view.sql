-- ============================================================================
-- WMS — Migration 0083: sku_commitments — which orders account for a SKU's
--                       reserved / layby stock (plus the near-miss statuses)
--
-- PROBLEM
--   The inventory screen shows Reserved and Layby as bare numbers. When a
--   packer asks "why is available 0 when there are 12 on the shelf?", the only
--   answer today is to trawl the orders list. There is no path from a stock
--   number back to the orders holding it, and no way to see the things that
--   LOOK like reservations but aren't (backorders, unpaid pending_payment
--   orders) — which is exactly where the confusion lives.
--
-- WHAT THIS IS
--   A read-only view: one row per OPEN order line that has any claim on a
--   child SKU, with the claim split into four separate quantity columns so the
--   numbers reconcile exactly against inventory_levels:
--
--     sum(reserved_qty) per stock_child_sku_id  = inventory_levels.reserved
--     sum(layby_qty)    per stock_child_sku_id  = inventory_levels.layby
--     backordered_qty   = units owed, holding NO stock (informational)
--     pending_qty       = unpaid pending_payment units, holding NO stock (0071)
--
--   Nothing is written and no existing object changes, so this is additive and
--   trivially reversible.
--
-- DELEGATION (0077 BOGO shared stock)
--   A BOGO "free" child delegates its stock to the paid counterpart, so a line
--   on the free SKU consumes the PAID SKU's reserved counter. The view keys on
--   stock_child_sku_id = coalesce(delegates_to_child_sku_id, id) — the SKU whose
--   inventory_levels row actually moved — and keeps the ordered SKU in
--   ordered_child_sku_id so the UI can say "via <free twin>". Keying on the
--   ordered SKU instead would make the totals fail to reconcile, which is the
--   whole point of the view.
--
-- WHICH ORDERS
--   status in (pending_payment, created, picking, packed). Excluded:
--     fulfilled  — stock consumed, no longer held
--     cancelled  — released
--     returned   — restocked to on_hand (0041)
--   on_hold is a FLAG, not a status: a held order still holds its reservation,
--   so it appears here with reserved_qty > 0 and on_hold = true. That is the
--   single most common "why is this stock gone?" answer, so it must be visible.
--
-- NON-INVENTORY SKUs (0068)
--   track_inventory = false SKUs never reserve. Their lines are included (so a
--   Shipping Protection line doesn't look like it vanished) but with all four
--   quantity columns at 0 and commitment_kind = 'service'.
--
-- SECURITY
--   security_invoker = true, so the caller's RLS site-scoping applies —
--   managers/ops see every site, clients see only theirs. Same posture as
--   backorder_report (0066) and orders_missing_packaging (0062).
-- ============================================================================

begin;

create or replace view public.sku_commitments with (security_invoker = true) as
select
  li.id                                   as line_id,
  -- The SKU whose inventory_levels row moved. Group by THIS to reconcile.
  coalesce(cs.delegates_to_child_sku_id, cs.id) as stock_child_sku_id,
  -- The SKU actually ordered. Differs from the above only for BOGO twins.
  cs.id                                   as ordered_child_sku_id,
  cs.sku                                  as ordered_sku,
  p.name                                  as ordered_product_name,
  (cs.delegates_to_child_sku_id is not null) as via_delegate,

  o.id                                    as order_id,
  o.order_number,
  o.site_id,
  s.name                                  as site_name,
  o.channel,
  o.order_type,
  o.status,
  o.on_hold,
  o.hold_reason,
  o.backordered                           as order_backordered,
  o.group_id,
  o.entered_at,
  o.sale_date,
  o.customer_id,
  c.name                                  as customer_name,

  li.quantity                             as ordered_qty,

  -- ---- the four claim buckets (mutually exclusive per line) ----------------
  -- Standard, activated, stock-tracked: reserved = quantity - backordered.
  case
    when cs.track_inventory is false            then 0
    when o.status = 'pending_payment'           then 0
    when o.order_type = 'layaway'               then 0
    else greatest(li.quantity - coalesce(li.backordered_qty, 0), 0)
  end                                     as reserved_qty,

  -- Layaway removed the units from on_hand at creation; layby is the parallel
  -- visibility counter. An unpaid (pending_payment) layaway booked nothing yet.
  case
    when cs.track_inventory is false            then 0
    when o.status = 'pending_payment'           then 0
    when o.order_type = 'layaway'               then li.quantity
    else 0
  end                                     as layby_qty,

  -- Owed but never reserved — stock is short. Holds nothing.
  case
    when cs.track_inventory is false            then 0
    when o.status = 'pending_payment'           then 0
    when o.order_type = 'layaway'               then 0
    else coalesce(li.backordered_qty, 0)
  end                                     as backordered_qty,

  -- Unpaid store order: reserves nothing until activate_pending_order (0072).
  case
    when cs.track_inventory is false            then 0
    when o.status = 'pending_payment'           then li.quantity
    else 0
  end                                     as pending_qty,

  -- Primary classification, for badge/grouping in the UI. Precedence matters:
  -- service < pending_payment < layby < hold < backorder < reserved.
  case
    when cs.track_inventory is false  then 'service'
    when o.status = 'pending_payment' then 'pending_payment'
    when o.order_type = 'layaway'     then 'layby'
    when o.on_hold                    then 'hold'
    when coalesce(li.backordered_qty, 0) >= li.quantity then 'backorder'
    else 'reserved'
  end                                     as commitment_kind

from public.order_line_items li
join public.orders     o  on o.id  = li.order_id
join public.child_skus cs on cs.id = li.child_sku_id
join public.products   p  on p.id  = cs.product_id
join public.sites      s  on s.id  = o.site_id
left join public.customers c on c.id = o.customer_id
where o.status in ('pending_payment', 'created', 'picking', 'packed');

comment on view public.sku_commitments is
  'One row per OPEN order line claiming a child SKU, keyed by stock_child_sku_id = coalesce(delegates_to_child_sku_id, id) so sum(reserved_qty) equals inventory_levels.reserved and sum(layby_qty) equals inventory_levels.layby for that SKU. backordered_qty and pending_qty hold NO stock and are informational. on_hold orders appear with reserved_qty > 0 (a hold keeps its reservation). Excludes fulfilled/cancelled/returned. security_invoker: site-scoped by the caller''s RLS.';

grant select on public.sku_commitments to authenticated;

-- Drill-in is always "one SKU at a time" from the inventory item page, so the
-- lookup path is order_line_items by child_sku_id. That index does not exist
-- (0001 only indexed by order_id), which would make every drill-in a seq scan
-- over the whole line-item table.
create index if not exists order_line_items_child_sku_idx
  on public.order_line_items(child_sku_id);

commit;
