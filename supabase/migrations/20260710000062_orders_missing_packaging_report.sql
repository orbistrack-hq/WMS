-- ============================================================================
-- WMS — Migration 0062: orders_missing_packaging report
--
-- WHY. Until migration 0061-era, a store-completed order (ShipStation ships it →
-- Shopify/Woo marks it completed → webhook) was auto-fulfilled in WMS: it jumped
-- straight to 'fulfilled', skipping the pick/pack screen. Packaging is recorded
-- per fulfillment_group via record_packaging_usage AT packing, so those
-- auto-fulfilled orders have NO packaging_usage rows — their box/label/jar/bag
-- cost and consumption were never captured, which the storefront billing +
-- packaging cost reports depend on.
--
-- Auto-fulfill is now OFF by default (STORE_SYNC_AUTOFULFILL), but orders that
-- were already auto-fulfilled need to be surfaced so the team can record their
-- packaging after the fact (record_packaging_usage has no status guard, so it
-- works on an already-fulfilled group).
--
-- WHAT. A fulfilled store-channel order whose fulfillment_group has zero
-- packaging_usage rows = packaging never captured. Grouped orders share one
-- group and packaging is counted once per group (the combine rule), so if ANY
-- packaging exists for the group the whole group is considered captured and
-- excluded. security_invoker = true so site scoping / RLS applies exactly like
-- the other report views. Read-only view; fully reversible (down drops it).
-- ============================================================================

begin;

create view public.orders_missing_packaging with (security_invoker = true) as
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
  gc.group_order_count
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

comment on view public.orders_missing_packaging is
  'Fulfilled Shopify/Woo orders whose fulfillment group has no packaging_usage — packaging cost/consumption was never captured (typically auto-fulfilled by a store webhook, skipping the packing screen). Record packaging via the packing screen / record_packaging_usage to clear.';

grant select on public.orders_missing_packaging to authenticated;

commit;
