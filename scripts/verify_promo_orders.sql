-- ============================================================================
-- WMS — verify promo orders end to end (READ ONLY)
--
-- Confirms that orders flagged is_promo (migration 0091) are actually being
-- kept out of the profit figures on /reports, and that nothing else moved.
--
-- Nothing here writes. Safe to run against production. Paste into the Supabase
-- SQL editor and run ONE SECTION AT A TIME — the editor only shows the last
-- statement's result set, so running the whole file at once hides sections 1–4.
--
-- WHAT "WORKING" LOOKS LIKE. /reports pulls every fulfilled order out of
-- landed_margin_report, drops the ones whose id is flagged is_promo, and sums
-- the rest. So the thing to prove is an identity:
--
--     (totals over ALL fulfilled orders)
--       = (what Analytics now shows)  +  (what it moved to Promo cost)
--
-- Section 2 checks exactly that. If it reads BALANCED, the split is sound and
-- no order fell down a gap between the two buckets.
--
-- SCOPE. Run as postgres in the SQL editor, this sees every site. The Analytics
-- page is RLS-scoped to the signed-in user — identical for an admin/manager/
-- operator, a subset for a client login. Compare like with like.
--
-- DATE WINDOW. Section 2 is unfiltered (all time). /reports defaults to its own
-- window, so set the same From/To there before comparing, or edit the `window`
-- CTE in section 2 to match the dates you have on screen.
-- ============================================================================


-- ── 1. Did the migrations actually land? ───────────────────────────────────
-- Run this first. If any row reads MISSING, `supabase db push` has not been
-- applied to this database and nothing below will mean anything.
select
  'orders.is_promo column'          as object,
  case when exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'orders'
       and column_name = 'is_promo'
  ) then 'OK' else 'MISSING — apply migration 0091' end as status
union all
select
  'set_order_promo() function',
  case when exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'set_order_promo'
  ) then 'OK' else 'MISSING — apply migration 0091' end
union all
select
  'find_or_create_customer() function',
  case when exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'find_or_create_customer'
  ) then 'OK' else 'MISSING — apply migration 0092' end
union all
select
  'landed_margin_report view',
  case when exists (
    select 1 from pg_views
     where schemaname = 'public' and viewname = 'landed_margin_report'
  ) then 'OK' else 'MISSING — apply migration 0027' end
union all
select
  'orders flagged is_promo',
  coalesce((select count(*)::text from public.orders where is_promo), '0');


-- ── 2. THE MAIN CHECK — does the split reconcile? ──────────────────────────
-- Reproduces exactly what app/(app)/reports/page.tsx does: take fulfilled
-- orders from landed_margin_report, split on is_promo, sum each side.
--
--   "Analytics shows"  → the Revenue / COGS / Net profit KPIs
--   "Promo cost"       → the violet Promo cost KPI (landed cost only; a promo
--                        order is costed, never credited)
--   "Difference"       → must be 0.00 on every row, or an order is being
--                        double-counted or dropped.
--
-- Edit the two dates in `date_window` to match the From/To on /reports; leave
-- as null for all time. If you also have a Site or Channel filter set on the
-- page, clear it before comparing — this query does not replicate those.
with date_window as (
  select null::date as from_date,      -- e.g. date '2026-08-01'
         null::date as to_date         -- e.g. date '2026-08-31'
),
report_rows as (
  select r.*, coalesce(o.is_promo, false) as is_promo
    from public.landed_margin_report r
    join public.orders o on o.id = r.order_id
   cross join date_window w
   where (w.from_date is null or r.sale_date >= w.from_date)
     and (w.to_date   is null or r.sale_date <= w.to_date)
),
paid as (
  select count(*) n, sum(revenue) rev, sum(product_cogs) cogs,
         sum(packaging_cost + shipping_cost) overhead,
         sum(landed_cost) landed, sum(net_profit) net
    from report_rows where not is_promo
),
promo as (
  select count(*) n, sum(revenue) rev, sum(product_cogs) cogs,
         sum(packaging_cost + shipping_cost) overhead,
         sum(landed_cost) landed, sum(net_profit) net
    from report_rows where is_promo
),
all_rows as (
  select count(*) n, sum(revenue) rev, sum(product_cogs) cogs,
         sum(packaging_cost + shipping_cost) overhead,
         sum(landed_cost) landed, sum(net_profit) net
    from report_rows
)
select metric, analytics_shows, moved_to_promo, all_fulfilled_orders,
       case when abs(difference) < 0.005 then 'BALANCED'
            else 'MISMATCH — investigate' end as reconciles
from (
  select 1 ord, 'Orders'       as metric,
         p.n::numeric as analytics_shows, m.n::numeric as moved_to_promo,
         a.n::numeric as all_fulfilled_orders,
         a.n - (p.n + m.n) as difference
    from paid p, promo m, all_rows a
  union all
  select 2, 'Revenue',
         round(coalesce(p.rev,0),2), round(coalesce(m.rev,0),2),
         round(coalesce(a.rev,0),2),
         coalesce(a.rev,0) - (coalesce(p.rev,0) + coalesce(m.rev,0))
    from paid p, promo m, all_rows a
  union all
  select 3, 'Product COGS',
         round(coalesce(p.cogs,0),2), round(coalesce(m.cogs,0),2),
         round(coalesce(a.cogs,0),2),
         coalesce(a.cogs,0) - (coalesce(p.cogs,0) + coalesce(m.cogs,0))
    from paid p, promo m, all_rows a
  union all
  select 4, 'Packaging + shipping',
         round(coalesce(p.overhead,0),2), round(coalesce(m.overhead,0),2),
         round(coalesce(a.overhead,0),2),
         coalesce(a.overhead,0) - (coalesce(p.overhead,0) + coalesce(m.overhead,0))
    from paid p, promo m, all_rows a
  union all
  -- moved_to_promo on this row IS the Promo cost KPI.
  select 5, 'Landed cost',
         round(coalesce(p.landed,0),2), round(coalesce(m.landed,0),2),
         round(coalesce(a.landed,0),2),
         coalesce(a.landed,0) - (coalesce(p.landed,0) + coalesce(m.landed,0))
    from paid p, promo m, all_rows a
  union all
  -- The payoff: net profit BEFORE (all_fulfilled_orders) vs AFTER (analytics_shows).
  select 6, 'Net profit',
         round(coalesce(p.net,0),2), round(coalesce(m.net,0),2),
         round(coalesce(a.net,0),2),
         coalesce(a.net,0) - (coalesce(p.net,0) + coalesce(m.net,0))
    from paid p, promo m, all_rows a
) x
order by ord;


-- ── 3. The flagged orders themselves ───────────────────────────────────────
-- Every order you marked promo. `in_analytics_yet` is the one to read: an order
-- only reaches the margin report once FULFILLED, so a promo order still sitting
-- in created/picking/packed changes nothing on /reports until it ships. That is
-- the most common reason for "I flagged it and the number didn't move".
select o.order_number,
       s.name                                        as site,
       o.channel,
       o.status,
       o.sale_date,
       case when r.order_id is null
            then 'not yet — order is ' || o.status
            else 'yes' end                           as in_analytics_yet,
       round(coalesce(r.revenue, 0), 2)              as revenue,
       round(coalesce(r.product_cogs, 0), 2)         as product_cogs,
       round(coalesce(r.packaging_cost, 0)
           + coalesce(r.shipping_cost, 0), 2)        as packaging_shipping,
       round(coalesce(r.landed_cost, 0), 2)          as counts_as_promo_cost
  from public.orders o
  join public.sites s                   on s.id = o.site_id
  left join public.landed_margin_report r on r.order_id = o.id
 where o.is_promo
 order by o.sale_date desc, o.order_number;


-- ── 4. Things that would make the numbers look wrong ───────────────────────
-- Empty result = nothing to worry about. Each row is a judgement call, not
-- necessarily a bug.
--
--   REVENUE ON A PROMO ORDER — the order was flagged but still carries a
--     price. That revenue has now vanished from Analytics. Correct for a
--     partly-comped order; a mistake if a real sale got flagged by accident.
--
--   PROMO SHARES A GROUP WITH A PAYING ORDER — combined shipment. The promo
--     order takes its revenue-share of that group's box and postage, and that
--     cost moves into Promo cost rather than reducing net profit. Intended,
--     but it means Promo cost is not purely "product given away".
--
--   FLAGGED BUT CANCELLED — harmless. Cancelled orders never enter the margin
--     report, so the flag does nothing. Listed only so it isn't a surprise.
select 'Revenue on a promo order' as finding,
       o.order_number,
       'revenue ' || round(r.revenue, 2)::text
         || ' is excluded from Analytics'            as detail
  from public.orders o
  join public.landed_margin_report r on r.order_id = o.id
 where o.is_promo and r.revenue > 0

union all
select 'Promo shares a group with a paying order',
       o.order_number,
       'group also holds ' || count(*)::text || ' paying order(s); promo absorbs '
         || round(r.packaging_cost + r.shipping_cost, 2)::text || ' of pkg+ship'
  from public.orders o
  join public.landed_margin_report r on r.order_id = o.id
  join public.orders sib on sib.group_id = o.group_id
                        and sib.id <> o.id
                        and not sib.is_promo
                        and sib.status <> 'cancelled'
 where o.is_promo
 group by o.order_number, r.packaging_cost, r.shipping_cost

union all
select 'Flagged but cancelled (no effect)',
       o.order_number,
       'cancelled orders never reach the margin report'
  from public.orders o
 where o.is_promo and o.status = 'cancelled'
 order by finding, order_number;


-- ── 5. Customers with no store identity (migration 0092 sanity check) ──────
-- Everyone created by find_or_create_customer shows up here — but so do guest
-- checkouts, because Shopify/Woo import also writes external_ref = null when
-- the store order carried no customer id. So this is a shortlist to eyeball,
-- not a definitive "created from the order form" list; the manual ones are the
-- recent rows whose names you recognise as influencers.
--
-- What to look for: two rows that are obviously the same person (a stray
-- period, a different spelling) mean the case-insensitive reuse did not catch
-- them. Cosmetic — the orders are still correct — but merge-worthy.
select c.name,
       c.email,
       c.created_at::date                            as created,
       count(o.id)                                   as orders,
       count(*) filter (where o.is_promo)            as promo_orders
  from public.customers c
  join public.orders o on o.customer_id = c.id
 where c.external_ref is null
 group by c.id, c.name, c.email, c.created_at
 order by c.created_at desc
 limit 50;
