-- ============================================================================
-- WMS — Migration 0028: backdatable fulfillment (Shopify order sync)
--
-- Shopify orders can arrive already fulfilled/archived (especially in the
-- historical backfill). The importer marks those WMS orders fulfilled straight
-- away — skipping pick/pack — through the SAME guarded fulfill_order() path so
-- inventory consume + pick-fee snapshot still happen. The only gap was the
-- date: fulfill_order() hard-coded now(), which would stamp a years-old order
-- as fulfilled "today" and skew the fulfilled-at column the COGS / landed-margin
-- reports read.
--
-- This migration adds an optional p_fulfilled_at so the import can preserve the
-- real Shopify fulfillment date. It defaults to now(), so every existing caller
-- (the order page's Fulfill button, tests) is unchanged. Because adding a
-- defaulted arg would make fulfill_order(uuid) ambiguous against the old
-- one-arg function, we drop the old signature first, then recreate.
--
-- Order NUMBERS are handled in application code, not here: the importer updates
-- orders.order_number to "SHOP-<shopify name>" after create_order returns
-- (order_number is a free-text label, already unique-constrained — no guarded
-- function needed).
-- ============================================================================

begin;

-- Defaulted-arg overloads would clash with the original fulfill_order(uuid);
-- drop it so only the new signature exists.
drop function if exists public.fulfill_order(uuid);

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

  -- fulfilled_at is set before charging so the pick fee resolves to the
  -- fulfillment date (now, or the backdated Shopify date when supplied).
  update public.orders set status = 'fulfilled', fulfilled_at = v_at
   where id = p_order_id returning * into v;
  perform public.apply_order_fulfillment(p_order_id);   -- inventory
  perform public.charge_order_pick_fee(p_order_id);     -- billing snapshot

  -- close the group once all its orders are fulfilled
  update public.fulfillment_groups g set status = 'fulfilled', fulfilled_at = v_at
   where g.id = v.group_id
     and not exists (select 1 from public.orders o where o.group_id = g.id and o.status <> 'fulfilled');
  return v;
end;
$$;

grant execute on function public.fulfill_order(uuid, timestamptz) to authenticated;

comment on function public.fulfill_order is
  'Fulfill an order: consume/clear inventory, snapshot the pick fee, mark fulfilled and close the group when complete. Optional p_fulfilled_at backdates the fulfillment (Shopify import preserves historical dates); defaults to now().';

commit;
