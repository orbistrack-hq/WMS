-- Rollback for migration 0105. Restores landed_margin_report to migration
-- 0104's function body (bounded by target_groups, but with the group_tot
-- multi-column GROUP BY that caused the cardinality misestimate).

begin;

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
    target_groups as (
      select distinct o.group_id
      from public.orders o
      where o.status = 'fulfilled'
        and o.sale_date >= p_from and o.sale_date <= p_to
    ),
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

commit;
