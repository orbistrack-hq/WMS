-- WMS — Migration 0089 (landed_margin_report full precision): DOWN
--
-- Restores the migration-0027 definition verbatim, including the four round()
-- calls. Reversing reinstates the per-row rounding, so Overview's aggregates go
-- back to drifting from Brand billing by cents — that is the point of a faithful
-- reverse, not an oversight.
--
-- create or replace, not drop: the view must keep existing for anything holding
-- a reference, and 0027's own down file is what drops it.

begin;

create or replace view public.landed_margin_report with (security_invoker = true) as
with
  order_rev as (
    select o.id                                as order_id,
           o.group_id,
           sum(li.quantity * li.unit_price)     as revenue
    from public.orders o
    join public.order_line_items li on li.order_id = o.id
    where o.status <> 'cancelled'
    group by o.id, o.group_id
  ),
  group_pack as (
    select group_id,
           sum(quantity * unit_cost_snapshot) as packaging_cost
    from public.packaging_usage
    group by group_id
  ),
  group_ship as (
    select group_id,
           sum(coalesce(actual_cost, estimated_cost, 0)) as shipping_cost
    from public.shipments
    where status <> 'cancelled'
    group by group_id
  ),
  group_tot as (
    select r.group_id,
           coalesce(gp.packaging_cost, 0) as packaging_cost,
           coalesce(gs.shipping_cost, 0)  as shipping_cost,
           sum(r.revenue)                 as group_revenue,
           count(*)                       as order_count
    from order_rev r
    left join group_pack gp on gp.group_id = r.group_id
    left join group_ship gs on gs.group_id = r.group_id
    group by r.group_id, gp.packaging_cost, gs.shipping_cost
  ),
  order_alloc as (
    select r.order_id,
           case
             when t.group_revenue > 0
               then t.packaging_cost * r.revenue / t.group_revenue
             else t.packaging_cost / nullif(t.order_count, 0)
           end as alloc_packaging,
           case
             when t.group_revenue > 0
               then t.shipping_cost * r.revenue / t.group_revenue
             else t.shipping_cost / nullif(t.order_count, 0)
           end as alloc_shipping
    from order_rev r
    join group_tot t on t.group_id = r.group_id
  )
select c.order_id,
       c.order_number,
       c.entered_at,
       c.sale_date,
       c.fulfilled_at,
       c.site_id,
       c.site_name,
       c.channel,
       c.status,
       c.revenue,
       c.discount,
       c.product_cogs,
       round(coalesce(a.alloc_packaging, 0), 2)                       as packaging_cost,
       round(coalesce(a.alloc_shipping, 0), 2)                        as shipping_cost,
       round(c.product_cogs
             + coalesce(a.alloc_packaging, 0)
             + coalesce(a.alloc_shipping, 0), 2)                      as landed_cost,
       c.gross_profit,
       round(c.gross_profit
             - coalesce(a.alloc_packaging, 0)
             - coalesce(a.alloc_shipping, 0), 2)                      as net_profit
from public.cogs_report c
left join order_alloc a on a.order_id = c.order_id;

comment on view public.landed_margin_report is
  'Order-grain fully-landed margin for fulfilled orders. Extends cogs_report by allocating each fulfillment group''s packaging + shipping cost across its non-cancelled orders by revenue share (equal split when group revenue is 0). landed_cost = product COGS + allocated packaging + allocated shipping; net_profit = product gross_profit - allocated packaging - shipping. Tax excluded (pass-through).';

grant select on public.landed_margin_report to authenticated;

commit;
