-- ============================================================================
-- WMS — Migration 0105: fix landed_margin_report's group_tot cardinality bug
--
-- WHY. Migration 0104's bounding fix (target_groups) was necessary but not
-- sufficient — EXPLAIN on the live DB (7,137 orders, 22,327 packaging_usage
-- rows) showed the real cause of the continued timeout: group_tot groups by
-- THREE columns —
--
--   group by r.group_id, gp.packaging_cost, gs.shipping_cost
--
-- — even though packaging_cost/shipping_cost are fully determined by
-- group_id (each group has exactly one packaging total, one shipping
-- total). That extra grouping was only ever there to satisfy Postgres's
-- "every non-aggregated SELECT column must be in GROUP BY" rule — Postgres
-- has no way to know the three columns are functionally dependent, so it
-- estimated group_tot's output as if they varied independently: 82,437 rows
-- from an input of ~3,813. That misestimate cascaded straight up the plan —
-- the top-level join ended up costed at 48 MILLION estimated rows, with a
-- 1.57-million-row Materialize step in between. Present in the original
-- 0027/0089 view too (copied verbatim into 0104) — bounding the CTEs by
-- target_groups didn't fix this specific miscount, since it isn't about
-- table size, it's about a bad plan shape from a bad cardinality estimate.
--
-- FIX. Pre-aggregate order_rev down to one row per group_id FIRST (its own
-- small, honest group by group_id), then LEFT JOIN packaging/shipping
-- totals in afterward. Both sides are now guaranteed exactly one row per
-- group_id, so no further GROUP BY is needed at all — no multi-column
-- grouping for the planner to misjudge. Arithmetic is unchanged: summing
-- revenue per group_id and then joining gives the identical group_revenue/
-- order_count/packaging_cost/shipping_cost as before. order_alloc, and
-- everything else, is untouched.
-- ============================================================================

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
    -- One row per group_id: the true grouping key, nothing else. Fixes the
    -- cardinality misestimate described above.
    group_rev as (
      select group_id,
             sum(revenue) as group_revenue,
             count(*)     as order_count
      from order_rev
      group by group_id
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
    -- gr/gp/gs are each exactly one row per group_id, so this join can't
    -- fan out — no GROUP BY needed here at all.
    group_tot as (
      select gr.group_id,
             coalesce(gp.packaging_cost, 0) as packaging_cost,
             coalesce(gs.shipping_cost, 0)  as shipping_cost,
             gr.group_revenue,
             gr.order_count
      from group_rev gr
      left join group_pack gp on gp.group_id = gr.group_id
      left join group_ship gs on gs.group_id = gr.group_id
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
  'Order-grain fully-landed margin for fulfilled orders with sale_date in [p_from, p_to]. See migration 0104 for the bounded-scope rewrite and 0105 for the group_tot cardinality fix (grouping by group_id, packaging_cost, shipping_cost together made the planner badly overestimate row counts, since the latter two are functionally dependent on the former). Same allocation formula and full-precision output as 0089. The allocation basis (order_rev) intentionally still spans a target group''s full non-cancelled order set regardless of individual sale_date, so an order''s allocated packaging/shipping share does not change depending on what date range a caller happens to request.';

commit;
