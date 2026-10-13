-- ============================================================================
-- WMS — Migration 0111: bounded storefront_fulfillment_cost for brand billing
--
-- WHY. The Brand billing page (app/(app)/reports/billing) read the 0030 view
-- storefront_fulfillment_cost and applied its period as a WHERE on the view's
-- OUTPUT (billing_date). Same trap as landed_margin_report (0104): the view's
-- grp_channel / grp_pack / grp_ship CTEs aggregate ALL of orders,
-- packaging_usage and shipments, grouped only by group_id, before the date
-- filter can touch anything. Under the app's `authenticated` role (8s
-- statement_timeout, plus per-row RLS) those page requests time out
-- intermittently. The page reads in 1000-row pages, so a timeout on page N
-- silently produced a PARTIAL total — Bud Club 2026-09 showed $0.00 on one
-- load and $2,322.38 on the next against a true $3,441.71.
--
-- FIX. A function taking the period (and optional site) as real parameters:
--   * target_groups — non-cancelled groups whose billing_date falls in
--     [p_from, p_to], found off a new expression index on
--     coalesce(fulfilled_at, created_at). Bounds are midnight Pacific; the
--     function pins timezone so that holds regardless of caller session, and
--     the result is identical to the view's ::date cast under 0049's zone.
--   * grp_channel / grp_pack / grp_ship join target_groups, so they only
--     aggregate rows for groups in the period.
--   * statement_timeout raised for this function only, as 0106 did — a safety
--     margin, not the fix.
--
-- Output columns and values are identical to the view's. The view itself is
-- left in place: storefront_monthly_billing still reads it.
-- Reverse with rollback/20261013000111_storefront_fulfillment_cost_bounded.down.sql.
-- ============================================================================

begin;

create index if not exists fulfillment_groups_billing_ts_idx
  on public.fulfillment_groups ((coalesce(fulfilled_at, created_at)));

create or replace function public.storefront_fulfillment_cost_for_period(
  p_from date,
  p_to   date,
  p_site uuid default null
)
returns table (
  group_id            uuid,
  site_id             uuid,
  site_name           text,
  channel             text,
  storefront          text,
  billing_date        date,
  group_status        text,
  channel_count       bigint,
  shipping_cost       numeric,
  box_cost            numeric,
  label_material_cost numeric,
  packaging_cost      numeric,
  total_reimbursable  numeric
)
language sql stable security invoker
set timezone = 'America/Los_Angeles'
set statement_timeout = '30s'
as $$
  with
    target_groups as (
      select g.id, g.site_id, g.status, g.fulfilled_at, g.created_at
      from public.fulfillment_groups g
      where g.status <> 'cancelled'
        and coalesce(g.fulfilled_at, g.created_at) >= p_from::timestamptz
        and coalesce(g.fulfilled_at, g.created_at) <  (p_to + 1)::timestamptz
        and (p_site is null or g.site_id = p_site)
    ),
    grp_channel as (
      select o.group_id,
             min(o.channel)            as channel,
             count(distinct o.channel) as channel_count
      from public.orders o
      join target_groups tg on tg.id = o.group_id
      where o.status <> 'cancelled'
      group by o.group_id
    ),
    grp_ship as (
      select s.group_id,
             sum(coalesce(s.actual_cost, s.estimated_cost, 0)) as shipping_cost
      from public.shipments s
      join target_groups tg on tg.id = s.group_id
      where s.status <> 'cancelled'
      group by s.group_id
    ),
    grp_pack as (
      select pu.group_id,
             sum(pu.quantity * pu.unit_cost_snapshot)                                          as packaging_cost,
             sum(pu.quantity * pu.unit_cost_snapshot) filter (where pt.kind = 'box')           as box_cost,
             sum(pu.quantity * pu.unit_cost_snapshot) filter (where pt.kind = 'shipping_label') as label_material_cost
      from public.packaging_usage pu
      join target_groups tg          on tg.id = pu.group_id
      join public.packaging_types pt on pt.id = pu.packaging_type_id
      group by pu.group_id
    ),
    -- One storefront label per site, not one lookup per group.
    site_store as (
      select distinct on (sc.site_id) sc.site_id, sc.source
      from public.store_connections sc
      where sc.is_active
        and sc.site_id in (select distinct tg.site_id from target_groups tg)
      order by sc.site_id, sc.created_at
    )
  select g.id                                          as group_id,
         g.site_id,
         s.name::text                                  as site_name,
         coalesce(gc.channel, 'manual')::text          as channel,
         ss.source::text                               as storefront,
         coalesce(g.fulfilled_at, g.created_at)::date  as billing_date,
         g.status::text                                as group_status,
         coalesce(gc.channel_count, 0)                 as channel_count,
         coalesce(gs.shipping_cost, 0)                 as shipping_cost,
         coalesce(gp.box_cost, 0)                      as box_cost,
         coalesce(gp.label_material_cost, 0)           as label_material_cost,
         coalesce(gp.packaging_cost, 0)                as packaging_cost,
         round(coalesce(gs.shipping_cost, 0)
               + coalesce(gp.packaging_cost, 0), 2)    as total_reimbursable
  from target_groups g
  join public.sites s        on s.id = g.site_id
  left join grp_channel gc   on gc.group_id = g.id
  left join grp_ship    gs   on gs.group_id = g.id
  left join grp_pack    gp   on gp.group_id = g.id
  left join site_store  ss   on ss.site_id = g.site_id;
$$;

comment on function public.storefront_fulfillment_cost_for_period(date, date, uuid) is
  'storefront_fulfillment_cost bounded to groups with billing_date in [p_from, p_to] (Pacific), optionally one site. Same columns and values as the view, but only aggregates orders/packaging_usage/shipments for groups in the period (migration 0111). Used by the Brand billing page.';

grant execute on function public.storefront_fulfillment_cost_for_period(date, date, uuid) to authenticated;

commit;
