-- ============================================================================
-- WMS — Migration 0027: landed margin report (analytics COGS basis)
--
-- cogs_report (migration 0019) stops at *product* margin: revenue − discount −
-- product COGS, deliberately leaving packaging and shipping out because those
-- are recorded at the fulfillment-GROUP grain and a combined group can hold
-- several orders. This migration does the layering that comment promised:
-- allocate each group's packaging + shipping cost down to its orders and expose
-- a fully-landed margin per fulfilled order.
--
-- ALLOCATION BASIS — revenue share. A group's shared packaging/shipping cost is
-- split across the group's non-cancelled orders in proportion to each order's
-- revenue (qty * unit_price). Rationale: a bigger-ticket order in a combined
-- shipment carries a larger share of the box/label/postage than a small add-on.
-- Fallback: when a group's orders have zero total revenue (e.g. all-free/sample
-- orders) the cost is split equally by order count so it is never dropped.
-- Cancelled orders neither receive an allocation nor count toward the basis.
--
-- SHIPPING COST BASIS — sum(coalesce(actual_cost, estimated_cost, 0)) over the
-- group's non-cancelled shipments (actual when known, else the estimate). This
-- matches the dashboard's convention and intentionally excludes per-package
-- costs, which are a separate rollup line in shipping_cost_report and would
-- double-count the carrier charge if added here.
--
-- GRAIN — one row per FULFILLED order (inherits cogs_report's fulfilled-only
-- filter). security_invoker, so each caller's site RLS still applies.
-- ============================================================================

begin;

create or replace view public.landed_margin_report with (security_invoker = true) as
with
  -- Revenue per non-cancelled order, plus its group, as the allocation basis.
  order_rev as (
    select o.id                                as order_id,
           o.group_id,
           sum(li.quantity * li.unit_price)     as revenue
    from public.orders o
    join public.order_line_items li on li.order_id = o.id
    where o.status <> 'cancelled'
    group by o.id, o.group_id
  ),
  -- Packaging cost per group (qty * frozen unit cost).
  group_pack as (
    select group_id,
           sum(quantity * unit_cost_snapshot) as packaging_cost
    from public.packaging_usage
    group by group_id
  ),
  -- Shipping cost per group: actual when present, else estimate; skip cancelled.
  group_ship as (
    select group_id,
           sum(coalesce(actual_cost, estimated_cost, 0)) as shipping_cost
    from public.shipments
    where status <> 'cancelled'
    group by group_id
  ),
  -- Per-group totals + allocation denominators (revenue sum and order count).
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
  -- Each order's allocated share of its group's packaging + shipping.
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
       -- Fully-landed cost basis: product + allocated packaging + shipping.
       round(c.product_cogs
             + coalesce(a.alloc_packaging, 0)
             + coalesce(a.alloc_shipping, 0), 2)                      as landed_cost,
       c.gross_profit,
       -- Net (landed) profit: product gross profit less allocated overheads.
       round(c.gross_profit
             - coalesce(a.alloc_packaging, 0)
             - coalesce(a.alloc_shipping, 0), 2)                      as net_profit
from public.cogs_report c
left join order_alloc a on a.order_id = c.order_id;

comment on view public.landed_margin_report is
  'Order-grain fully-landed margin for fulfilled orders. Extends cogs_report by allocating each fulfillment group''s packaging + shipping cost across its non-cancelled orders by revenue share (equal split when group revenue is 0). landed_cost = product COGS + allocated packaging + allocated shipping; net_profit = product gross_profit - allocated packaging - shipping. Tax excluded (pass-through).';

grant select on public.landed_margin_report to authenticated;

commit;
