-- ============================================================================
-- WMS — Migration 0030: per-storefront fulfillment cost report
--
-- Purpose: let the fulfillment operation see, per storefront/brand, what it
-- spent on shipping (postage/labels) and packaging over a period, so each brand
-- can be billed monthly and reimbursed. "One site = one brand", so the roll-up
-- key is the SITE; channel + store domain are surfaced alongside it.
--
-- This is a REPORTING-ONLY change (two views + grants). It does NOT add an
-- invoice / paid-unpaid layer yet — that is a deliberate later phase. Nothing
-- here writes data or touches the order/shipping lifecycle.
--
-- COST CONVENTIONS — identical to landed_margin_report (migration 0027) so the
-- numbers reconcile across reports:
--   * Shipping  = sum(coalesce(actual_cost, estimated_cost, 0)) over the
--                 group's NON-CANCELLED shipments. Per-package costs are a
--                 separate line in shipping_cost_report and are intentionally
--                 excluded here — adding them would double-count the carrier
--                 charge.
--   * Packaging = sum(quantity * unit_cost_snapshot) from packaging_usage.
--                 Usage is recorded at the fulfillment-GROUP grain, so box +
--                 shipping-label are counted ONCE per group and consumables
--                 (jars, jar labels, bags) sum across combined orders — the
--                 combined-order double-count rule is satisfied for free.
--
-- STOREFRONT ATTRIBUTION — the channel is read from the group's non-cancelled
-- orders (orders.channel; readable under the same site RLS). One channel per
-- site means a group is single-channel; the rare mixed group is collapsed
-- deterministically and flagged via channel_count so it can be spotted. The
-- store domain (source) is a nice-to-have label left-joined from
-- store_connections and may be null for manual-only sites.
--
-- BILLING DATE — coalesce(fulfilled_at, created_at) of the group, so a monthly
-- statement is keyed to when the group was fulfilled (falling back to created).
--
-- GRAIN — storefront_fulfillment_cost: one row per non-cancelled fulfillment
-- group. storefront_monthly_billing: one row per site+channel+month.
-- Both security_invoker, so each caller's site RLS still applies.
-- Reverse with rollback/20260702000030_storefront_billing_cost_report.down.sql.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- Detail view: per fulfillment group, the billable/reimbursable cost with a
-- shipping + packaging breakdown and its storefront/brand context.
-- ----------------------------------------------------------------------------
create or replace view public.storefront_fulfillment_cost
  with (security_invoker = true) as
with
  -- Channel per group from its non-cancelled orders. One channel per site, so
  -- min() collapses the expected single value; channel_count flags any mix.
  grp_channel as (
    select o.group_id,
           min(o.channel)            as channel,
           count(distinct o.channel) as channel_count
    from public.orders o
    where o.status <> 'cancelled'
    group by o.group_id
  ),
  -- Shipping per group: actual when known, else estimate; cancelled shipments
  -- excluded. Per-package cost deliberately not added (see header).
  grp_ship as (
    select group_id,
           sum(coalesce(actual_cost, estimated_cost, 0)) as shipping_cost
    from public.shipments
    where status <> 'cancelled'
    group by group_id
  ),
  -- Packaging per group, with box and shipping-label material broken out.
  grp_pack as (
    select pu.group_id,
           sum(pu.quantity * pu.unit_cost_snapshot)                                          as packaging_cost,
           sum(pu.quantity * pu.unit_cost_snapshot) filter (where pt.kind = 'box')           as box_cost,
           sum(pu.quantity * pu.unit_cost_snapshot) filter (where pt.kind = 'shipping_label') as label_material_cost
    from public.packaging_usage pu
    join public.packaging_types pt on pt.id = pu.packaging_type_id
    group by pu.group_id
  )
select g.id                                              as group_id,
       g.site_id,
       s.name                                            as site_name,
       coalesce(gc.channel, 'manual')                    as channel,
       sf.source                                         as storefront,
       coalesce(g.fulfilled_at, g.created_at)::date      as billing_date,
       g.status                                          as group_status,
       coalesce(gc.channel_count, 0)                     as channel_count,
       coalesce(gs.shipping_cost, 0)                     as shipping_cost,
       coalesce(gp.box_cost, 0)                          as box_cost,
       coalesce(gp.label_material_cost, 0)               as label_material_cost,
       coalesce(gp.packaging_cost, 0)                    as packaging_cost,
       round(coalesce(gs.shipping_cost, 0)
             + coalesce(gp.packaging_cost, 0), 2)        as total_reimbursable
from public.fulfillment_groups g
join public.sites s              on s.id = g.site_id
left join grp_channel gc         on gc.group_id = g.id
left join grp_ship    gs         on gs.group_id = g.id
left join grp_pack    gp         on gp.group_id = g.id
left join lateral (
  select sc.source
    from public.store_connections sc
   where sc.site_id = g.site_id and sc.is_active
   order by sc.created_at
   limit 1
) sf on true
where g.status <> 'cancelled';

comment on view public.storefront_fulfillment_cost is
  'Per fulfillment group: shipping (postage, actual-or-estimate) + packaging cost with box and shipping-label material broken out, plus storefront/brand context (site, channel, store domain) and a billing_date. Reimbursement basis for monthly brand billing. Excludes cancelled groups and cancelled shipments; per-package carrier costs excluded to avoid double count. Matches landed_margin_report conventions.';

-- ----------------------------------------------------------------------------
-- Roll-up view: per site (brand) + channel + month — the monthly statement grid.
-- ----------------------------------------------------------------------------
create or replace view public.storefront_monthly_billing
  with (security_invoker = true) as
select site_id,
       site_name,
       channel,
       storefront,
       date_trunc('month', billing_date)::date as billing_month,
       count(*)                                as group_count,
       sum(shipping_cost)                      as shipping_cost,
       sum(box_cost)                           as box_cost,
       sum(label_material_cost)                as label_material_cost,
       sum(packaging_cost)                     as packaging_cost,
       round(sum(total_reimbursable), 2)       as total_reimbursable
from public.storefront_fulfillment_cost
group by site_id, site_name, channel, storefront, date_trunc('month', billing_date);

comment on view public.storefront_monthly_billing is
  'Monthly reimbursement statement per brand: for each site + channel + month, the total shipping + packaging spent, with box and shipping-label material broken out. One site = one brand. Filter by billing_month range in the app. Add invoice / paid-unpaid tracking in a later phase.';

grant select on public.storefront_fulfillment_cost to authenticated;
grant select on public.storefront_monthly_billing  to authenticated;

commit;
