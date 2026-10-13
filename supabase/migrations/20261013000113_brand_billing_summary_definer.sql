-- ============================================================================
-- WMS — Migration 0113: brand_billing_summary checks site access ONCE, not per row
--
-- WHY. 0112's summary was security invoker, so every row it read went through
-- RLS: can_access_site(site_id) on fulfillment_groups and orders, plus an
-- EXISTS-and-can_access_site on every order_line_items, billing_charges and
-- packaging_usage row. can_access_site is security definer with its own
-- search_path, so it can never be inlined — it runs (with is_operator() and an
-- access lookup inside) once per row. A month is tens of thousands of rows.
-- Measured on prod-like volume (~3k orders/month): 90 ms without RLS, 7.9 s as
-- an authenticated operator. On prod that crossed the 8s limit on every
-- attempt and the Brand billing page showed "could not be loaded". The 0.2–1.5 s
-- timings taken when 0112 shipped were with the service key, which skips RLS.
--
-- FIX. security definer, with access decided once per SITE up front:
--   allowed = sites the caller can_access_site(), narrowed to p_site if given.
-- Every figure in the summary is keyed by site — groups and orders carry
-- site_id, and line items / charges / packaging are only reached through
-- those groups and orders — so restricting both entry points (cost groups and
-- period orders) to allowed sites returns exactly what RLS would have: the
-- child-table policies check the same parent site. An anonymous caller has no
-- allowed sites and gets nothing; execute is granted to authenticated only.
--
-- Output columns and values are unchanged from 0112.
-- Reverse with rollback/20261013000113_brand_billing_summary_definer.down.sql.
-- ============================================================================

begin;

create or replace function public.brand_billing_summary(
  p_from date,
  p_to   date,
  p_site uuid default null
)
returns table (
  site_id                  uuid,
  site_name                text,
  channel                  text,
  storefront               text,
  fulfilled_groups         bigint,
  open_groups              bigint,
  packaging                numeric,
  store_gap_groups         bigint,
  manual_gap_groups        bigint,
  mixed_channel_groups     bigint,
  orders                   bigint,
  units                    bigint,
  pick_fees                numeric,
  missing_fee_order_ids     uuid[],
  missing_fee_order_numbers text[]
)
language sql stable security definer
set search_path = ''
set timezone = 'America/Los_Angeles'
set statement_timeout = '30s'
as $$
  with
    -- The one access check: a handful of sites, not every row.
    allowed as (
      select s.id
      from public.sites s
      where public.can_access_site(s.id)
        and (p_site is null or s.id = p_site)
    ),
    cost as (
      select c.*
      from public.storefront_fulfillment_cost_for_period(p_from, p_to, p_site) c
      where c.site_id in (select a.id from allowed a)
    ),
    cost_by_site as (
      select c.site_id,
             min(c.channel)    filter (where c.group_status = 'fulfilled') as channel,
             min(c.storefront) filter (where c.group_status = 'fulfilled') as storefront,
             count(*) filter (where c.group_status = 'fulfilled')          as fulfilled_groups,
             count(*) filter (where c.group_status <> 'fulfilled')         as open_groups,
             coalesce(sum(c.packaging_cost) filter (where c.group_status = 'fulfilled'), 0) as packaging,
             count(*) filter (where c.group_status = 'fulfilled' and c.packaging_cost = 0
                                and c.channel in ('shopify','woocommerce'))  as store_gap_groups,
             count(*) filter (where c.group_status = 'fulfilled' and c.packaging_cost = 0
                                and c.channel not in ('shopify','woocommerce')) as manual_gap_groups,
             count(*) filter (where c.group_status = 'fulfilled' and c.channel_count > 1) as mixed_channel_groups
      from cost c
      group by c.site_id
    ),
    -- Orders fulfilled in the period, Pacific days, allowed sites only.
    period_orders as (
      select o.id, o.site_id, o.status, o.order_number
      from public.orders o
      where o.fulfilled_at >= p_from::timestamptz
        and o.fulfilled_at <  (p_to + 1)::timestamptz
        and o.site_id in (select a.id from allowed a)
    ),
    charged as (
      select po.id as order_id, po.site_id, bc.amount
      from period_orders po
      join public.billing_charges bc on bc.order_id = po.id and bc.fee_type = 'pick_fee'
      where po.status <> 'cancelled'
    ),
    charged_units as (
      select ch.order_id, sum(li.quantity) as units
      from charged ch
      join public.order_line_items li on li.order_id = ch.order_id
      group by ch.order_id
    ),
    fees_by_site as (
      select ch.site_id,
             count(*)                        as orders,
             coalesce(sum(cu.units), 0)      as units,
             sum(ch.amount)                  as pick_fees
      from charged ch
      left join charged_units cu on cu.order_id = ch.order_id
      group by ch.site_id
    ),
    missing_by_site as (
      select po.site_id,
             array_agg(po.id           order by po.order_number desc) as ids,
             array_agg(po.order_number order by po.order_number desc) as numbers
      from period_orders po
      where po.status = 'fulfilled'
        and not exists (select 1 from public.billing_charges bc
                         where bc.order_id = po.id and bc.fee_type = 'pick_fee')
      group by po.site_id
    ),
    all_sites as (
      select cs.site_id from cost_by_site cs
      union select fs.site_id from fees_by_site fs
      union select ms.site_id from missing_by_site ms
    )
  select a.site_id,
         s.name::text,
         coalesce(cs.channel, 'manual')::text,
         cs.storefront::text,
         coalesce(cs.fulfilled_groups, 0),
         coalesce(cs.open_groups, 0),
         coalesce(cs.packaging, 0),
         coalesce(cs.store_gap_groups, 0),
         coalesce(cs.manual_gap_groups, 0),
         coalesce(cs.mixed_channel_groups, 0),
         coalesce(fs.orders, 0),
         coalesce(fs.units, 0)::bigint,
         coalesce(fs.pick_fees, 0),
         coalesce(ms.ids, '{}'),
         coalesce(ms.numbers, '{}')
  from all_sites a
  join public.sites s          on s.id = a.site_id
  left join cost_by_site cs    on cs.site_id = a.site_id
  left join fees_by_site fs    on fs.site_id = a.site_id
  left join missing_by_site ms on ms.site_id = a.site_id
  order by s.name;
$$;

comment on function public.brand_billing_summary(date, date, uuid) is
  'Brand billing page in one call: per site for the period, fulfilled-group packaging (with gap / mixed-channel counts and open groups), pick fees with order and unit counts, and the fulfilled orders missing a pick fee. Pacific days. security definer since 0113: site access is checked once per site via can_access_site instead of per row through RLS (which made it time out); results are limited to the caller''s sites exactly as RLS would.';

-- Definer functions must not be callable by anyone who could not see the data.
revoke all on function public.brand_billing_summary(date, date, uuid) from public, anon;
grant execute on function public.brand_billing_summary(date, date, uuid) to authenticated;

commit;
