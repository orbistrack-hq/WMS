-- ============================================================================
-- WMS — Migration 0104: landed_margin_report becomes a bounded function
--
-- WHY. landed_margin_report (0027, precision-fixed in 0089) is a plain view.
-- The reports page applies its from/to date filter as a WHERE on the view's
-- OUTPUT (PostgREST's .gte()/.lte()), but two of the view's CTEs — group_pack
-- and group_ship — aggregate ALL of packaging_usage and ALL of shipments,
-- grouped only by group_id, with no order_id or sale_date column anywhere in
-- them. There is nothing for an output-side date filter to ever reach: every
-- load recomputes those two aggregates over the ENTIRE table history first,
-- then discards most of the joined result. Confirmed empirically — bounding
-- the reports page to 90 days, then 30, timed out identically, because the
-- expensive part of the query was never actually shrinking.
--
-- FIX. Replace the view with a function taking p_from/p_to as real
-- parameters, so the date range can bound the query BEFORE the aggregation
-- runs, not after:
--   * target_groups — fulfillment groups that actually have a fulfilled
--     order landing in [p_from, p_to]. Computed once, off the new
--     orders_sale_date_idx below.
--   * group_pack / group_ship — now join against target_groups, so they only
--     aggregate packaging_usage / shipments rows for groups that matter to
--     this call, instead of the whole table.
--   * order_rev — DELIBERATELY still revenue-shares across ALL non-cancelled
--     orders in a target group regardless of THEIR OWN sale_date (only
--     group-restricted, not date-restricted). A group's packaging/shipping
--     split must be the same fact no matter what date range a report happens
--     to be viewing — date-filtering the allocation basis itself would make
--     an order's landed cost depend on which report window you picked, which
--     is wrong. Matches 0027's original allocation semantics exactly; only
--     the SCOPE of computation changes, not the math.
--   * The final select still filters cogs_report by sale_date directly
--     (cogs_report has no CTEs, so this pushes cleanly to the orders scan).
--
-- Output columns/values are unchanged from 0089 (full precision, same
-- allocation formula) — this is a performance rewrite, not a numbers change.
-- app/(app)/reports/page.tsx switches from .from(view) to
-- .rpc(function, { p_from, p_to }) in the same deploy as this migration.
-- ============================================================================

begin;

-- Supports both target_groups (range scan) and, combined with the existing
-- orders_status_idx, cogs_report's own sale_date filter.
create index if not exists orders_sale_date_idx on public.orders(sale_date);

drop view if exists public.landed_margin_report;

create or replace function public.landed_margin_report(p_from date, p_to date)
returns table (
  order_id       uuid,
  order_number   text,
  entered_at     timestamptz,
  sale_date      date,
  fulfilled_at   timestamptz,
  site_id        uuid,
  site_name      text,
  channel        text,
  status         text,
  revenue        numeric,
  discount       numeric,
  product_cogs   numeric,
  packaging_cost numeric,
  shipping_cost  numeric,
  landed_cost    numeric,
  gross_profit   numeric,
  net_profit     numeric
)
language sql stable security invoker as $$
  with
    -- Groups with a fulfilled order landing in range — same criteria as
    -- cogs_report's own filter, so this is exactly the set of groups whose
    -- totals the final result set can possibly need.
    target_groups as (
      select distinct o.group_id
      from public.orders o
      where o.status = 'fulfilled'
        and o.sale_date >= p_from and o.sale_date <= p_to
    ),
    -- Revenue per non-cancelled order in a target group — ALL of the group's
    -- orders, any sale_date, so the allocation basis matches 0027 exactly.
    order_rev as (
      select o.id                                as order_id,
             o.group_id,
             sum(li.quantity * li.unit_price)     as revenue
      from public.orders o
      join public.order_line_items li on li.order_id = o.id
      join target_groups tg            on tg.group_id = o.group_id
      where o.status <> 'cancelled'
      group by o.id, o.group_id
    ),
    group_pack as (
      select pu.group_id,
             sum(pu.quantity * pu.unit_cost_snapshot) as packaging_cost
      from public.packaging_usage pu
      join target_groups tg on tg.group_id = pu.group_id
      group by pu.group_id
    ),
    group_ship as (
      select s.group_id,
             sum(coalesce(s.actual_cost, s.estimated_cost, 0)) as shipping_cost
      from public.shipments s
      join target_groups tg on tg.group_id = s.group_id
      where s.status <> 'cancelled'
      group by s.group_id
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
         coalesce(a.alloc_packaging, 0)                            as packaging_cost,
         coalesce(a.alloc_shipping, 0)                             as shipping_cost,
         c.product_cogs
           + coalesce(a.alloc_packaging, 0)
           + coalesce(a.alloc_shipping, 0)                         as landed_cost,
         c.gross_profit,
         c.gross_profit
           - coalesce(a.alloc_packaging, 0)
           - coalesce(a.alloc_shipping, 0)                         as net_profit
  from public.cogs_report c
  left join order_alloc a on a.order_id = c.order_id
  where c.sale_date >= p_from and c.sale_date <= p_to;
$$;

comment on function public.landed_margin_report(date, date) is
  'Order-grain fully-landed margin for fulfilled orders with sale_date in [p_from, p_to]. Replaces the 0089 view — same allocation formula and full-precision output, but bounded: only scans packaging_usage/shipments for groups relevant to the range, instead of the whole table (migration 0104). The allocation basis (order_rev) intentionally still spans a target group''s full non-cancelled order set regardless of individual sale_date, so an order''s allocated packaging/shipping share does not change depending on what date range a caller happens to request.';

grant execute on function public.landed_margin_report(date, date) to authenticated;

commit;
