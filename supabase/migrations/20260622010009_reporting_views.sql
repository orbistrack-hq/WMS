-- ============================================================================
-- WMS — Migration 0009: reporting views
--
-- All views are security_invoker, so each one inherits the caller's row-level
-- security on the underlying tables: operators see every site, a client sees
-- only its assigned sites. No separate report-level access logic needed.
--
-- These are query shapes; the app adds date-range / site / channel filters and
-- the field-picker CSV export on top.
-- ============================================================================

begin;

-- Sales: one row per order line, with order context. revenue = qty * unit_price.
create view public.sales_report with (security_invoker = true) as
select o.id              as order_id,
       o.order_number,
       o.entered_at,
       o.sale_date,
       o.site_id,
       s.name            as site_name,
       o.customer_id,
       c.name            as customer_name,
       o.channel,
       o.status,
       li.id             as line_id,
       li.child_sku_id,
       p.name            as product_name,
       cs.sku,
       li.quantity,
       li.unit_price,
       (li.quantity * li.unit_price) as revenue,
       li.discount,
       li.tax
from public.orders o
join public.sites s              on s.id  = o.site_id
left join public.customers c     on c.id  = o.customer_id
join public.order_line_items li  on li.order_id = o.id
join public.child_skus cs        on cs.id = li.child_sku_id
join public.products p           on p.id  = cs.product_id;

-- Inventory: levels per child SKU per site, valued at cost.
create view public.inventory_report with (security_invoker = true) as
select cs.id            as child_sku_id,
       cs.site_id,
       s.name           as site_name,
       p.name           as product_name,
       cs.sku,
       il.on_hand,
       il.available,
       il.reserved,
       il.layby,
       cs.cost,
       (il.on_hand * cs.cost) as value_at_cost
from public.child_skus cs
join public.sites s            on s.id  = cs.site_id
join public.products p         on p.id  = cs.product_id
join public.inventory_levels il on il.child_sku_id = cs.id;

-- Packaging cost: consumption + cost by type, per fulfillment group.
create view public.packaging_cost_report with (security_invoker = true) as
select g.id             as group_id,
       g.site_id,
       s.name           as site_name,
       pt.kind,
       pt.name          as packaging_name,
       sum(pu.quantity)                          as quantity,
       sum(pu.quantity * pu.unit_cost_snapshot)  as cost,
       g.created_at,
       g.fulfilled_at
from public.packaging_usage pu
join public.fulfillment_groups g on g.id = pu.group_id
join public.sites s              on s.id = g.site_id
join public.packaging_types pt   on pt.id = pu.packaging_type_id
group by g.id, g.site_id, s.name, pt.kind, pt.name, g.created_at, g.fulfilled_at;

-- Shipping cost: estimated vs actual per shipment, with package rollup + variance.
create view public.shipping_cost_report with (security_invoker = true) as
select sh.id            as shipment_id,
       sh.group_id,
       g.site_id,
       s.name           as site_name,
       sh.carrier,
       sh.service_level,
       sh.estimated_cost,
       sh.actual_cost,
       (sh.actual_cost - sh.estimated_cost) as variance,
       coalesce(pk.package_count, 0)        as package_count,
       coalesce(pk.package_cost, 0)         as package_cost,
       sh.status,
       sh.created_at
from public.shipments sh
join public.fulfillment_groups g on g.id = sh.group_id
join public.sites s              on s.id = g.site_id
left join (
  select shipment_id, count(*) as package_count, sum(cost) as package_cost
    from public.packages group by shipment_id) pk on pk.shipment_id = sh.id;

-- Billing: client-billable charges by fee type, with order/site context.
create view public.billing_report with (security_invoker = true) as
select bc.id            as charge_id,
       bc.order_id,
       o.order_number,
       o.site_id,
       s.name           as site_name,
       o.customer_id,
       bc.fee_type,
       bc.quantity,
       bc.amount,
       bc.created_at
from public.billing_charges bc
join public.orders o on o.id = bc.order_id
join public.sites s  on s.id = o.site_id;

commit;