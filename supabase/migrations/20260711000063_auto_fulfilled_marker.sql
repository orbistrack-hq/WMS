-- ============================================================================
-- WMS — Migration 0063: auto_fulfilled marker on orders
--
-- WHY. When STORE_SYNC_AUTOFULFILL is on, a store-completed order (ShipStation
-- ships it → Shopify/Woo marks it completed → webhook/backfill) is fulfilled in
-- WMS without going through the pick/pack screen. Operationally these need to be
-- distinguishable from orders packed locally in WMS: they were "completed
-- upstream, before/without OT packing", their fulfilled_at is backdated to the
-- store's real ship date, and their packaging still has to be reconciled after
-- the fact (they show in orders_missing_packaging).
--
-- WHAT.
--   1. orders.auto_fulfilled boolean (default false) — the persistent marker.
--   2. fulfill_order gains p_auto_fulfilled (drop the 2-arg first so the new
--      3-arg DEFAULTED signature doesn't create an overload clash — same
--      precaution as migration 0028). Body is otherwise unchanged.
--   3. orders_missing_packaging re-exposes auto_fulfilled (appended at the end so
--      CREATE OR REPLACE VIEW is legal). Its WHERE clause is UNCHANGED, so the
--      packaging-gaps screen keeps surfacing exactly the same orders.
--
-- Additive and fully reversible (see rollback/*.down.sql).
-- ============================================================================

begin;

alter table public.orders
  add column if not exists auto_fulfilled boolean not null default false;

comment on column public.orders.auto_fulfilled is
  'True when the order was fulfilled automatically from a store-completed state (e.g. ShipStation shipped it and the store marked it completed) rather than packed locally in WMS. Set via fulfill_order(..., p_auto_fulfilled => true).';

-- Drop the 2-arg version before creating the defaulted 3-arg one so a bare
-- fulfill_order(uuid) / fulfill_order(uuid, ts) call stays unambiguous.
drop function if exists public.fulfill_order(uuid, timestamptz);

create or replace function public.fulfill_order(
  p_order_id       uuid,
  p_fulfilled_at   timestamptz default null,
  p_auto_fulfilled boolean default false
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
  if v.status = 'returned' then raise exception 'Order % is returned; re-open it before fulfilling', p_order_id; end if;

  update public.orders
     set status = 'fulfilled',
         fulfilled_at = v_at,
         auto_fulfilled = p_auto_fulfilled
   where id = p_order_id returning * into v;
  perform public.apply_order_fulfillment(p_order_id);
  perform public.charge_order_pick_fee(p_order_id);

  update public.fulfillment_groups g set status = 'fulfilled', fulfilled_at = v_at
   where g.id = v.group_id
     and not exists (select 1 from public.orders o where o.group_id = g.id and o.status <> 'fulfilled');
  return v;
end;
$$;

grant execute on function public.fulfill_order(uuid, timestamptz, boolean) to authenticated;

comment on function public.fulfill_order is
  'Fulfill an order: consume/clear inventory, snapshot the pick fee, and close the fulfillment group once all its orders are fulfilled. p_fulfilled_at backdates the fulfillment (store-completed orders keep their real ship date). p_auto_fulfilled marks a store-completed auto-fulfillment that skipped local packing (surfaces in orders_missing_packaging until packaging is recorded).';

-- Re-expose auto_fulfilled on the packaging-gap report (appended last). WHERE is
-- identical to migration 0062, so the packaging-gaps screen is unaffected.
create or replace view public.orders_missing_packaging with (security_invoker = true) as
select
  o.id            as order_id,
  o.order_number,
  o.site_id,
  s.name          as site_name,
  o.customer_id,
  c.name          as customer_name,
  o.channel,
  o.order_type,
  o.group_id,
  o.entered_at,
  o.sale_date,
  o.fulfilled_at,
  coalesce(li.line_count, 0)  as line_count,
  coalesce(li.unit_count, 0)  as unit_count,
  coalesce(li.order_value, 0) as order_value,
  gc.group_order_count,
  o.auto_fulfilled
from public.orders o
join public.sites s on s.id = o.site_id
left join public.customers c on c.id = o.customer_id
left join lateral (
  select count(*)      as line_count,
         sum(quantity) as unit_count,
         sum(quantity * unit_price - coalesce(discount,0) + coalesce(tax,0)) as order_value
    from public.order_line_items
   where order_id = o.id
) li on true
left join lateral (
  select count(*) as group_order_count
    from public.orders og
   where og.group_id = o.group_id
) gc on true
where o.status = 'fulfilled'
  and o.channel in ('shopify','woocommerce')
  and not exists (
    select 1 from public.packaging_usage pu where pu.group_id = o.group_id
  );

grant select on public.orders_missing_packaging to authenticated;

commit;
