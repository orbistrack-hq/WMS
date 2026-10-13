-- ============================================================================
-- WMS — Migration 0112: brand_billing_summary — the Brand billing page in one call
--
-- WHY. After 0111 the page was correct but slow (~4s): it downloaded every
-- cost row, pick-fee charge, fulfilled order and line item in the period —
-- about 20 sequential requests — only to sum them into one row per brand.
-- Each extra request was another chance to time out and show the "did not
-- fully load" error.
--
-- FIX. Do the roll-up here and return one row per brand: a single request,
-- a handful of rows. Semantics are the page's, unchanged:
--   * Packaging   — FULFILLED groups from storefront_fulfillment_cost_for_period
--                   (billing_date in the period). Open groups are counted, not
--                   billed. Gaps (fulfilled, $0 packaging) are split store vs
--                   manual channel because they are cleared in different places.
--   * Pick fees   — pick_fee charges on non-cancelled orders whose fulfilled_at
--                   falls in the period (Pacific days). orders = charges (one
--                   per order, unique index), units = their line-item quantity.
--   * Missing     — fulfilled orders in the period with no pick_fee charge,
--                   returned as id + order_number arrays for the backfill button.
-- A site appears if it has anything in any of these sets; the page only lists
-- brands with fulfilled groups or charges, as before.
--
-- Plus orders_fulfilled_at_idx: both the charge and missing-fee legs range-scan
-- orders.fulfilled_at, which had no index.
-- Reverse with rollback/20261013000112_brand_billing_summary.down.sql.
-- ============================================================================

begin;

create index if not exists orders_fulfilled_at_idx on public.orders(fulfilled_at);

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
language sql stable security invoker
set timezone = 'America/Los_Angeles'
set statement_timeout = '30s'
as $$
  with
    cost as (
      select * from public.storefront_fulfillment_cost_for_period(p_from, p_to, p_site)
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
    -- Orders fulfilled in the period, Pacific days.
    period_orders as (
      select o.id, o.site_id, o.status, o.order_number
      from public.orders o
      where o.fulfilled_at >= p_from::timestamptz
        and o.fulfilled_at <  (p_to + 1)::timestamptz
        and (p_site is null or o.site_id = p_site)
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
  'Brand billing page in one call: per site for the period, fulfilled-group packaging (with gap / mixed-channel counts and open groups), pick fees with order and unit counts, and the fulfilled orders missing a pick fee. Pacific days. Same semantics the page computed client-side before migration 0112.';

grant execute on function public.brand_billing_summary(date, date, uuid) to authenticated;

commit;
