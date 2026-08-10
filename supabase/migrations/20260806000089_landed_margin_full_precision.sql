-- ============================================================================
-- WMS — Migration 0089: landed_margin_report keeps full precision
--
-- PROBLEM (found reconciling Overview against Brand billing, 2026-08-06)
--   For Bud Club, 1–5 Aug: Overview reported $757.20 of packaging, Brand
--   billing $757.61. Same packaging, two numbers.
--
--   The cause is rounding in the wrong layer. alloc_packaging is a SYNTHETIC
--   value — a fulfillment group's packaging split across its orders by revenue
--   share — so it lands on things like 1.7528333. Migration 0027 rounded that
--   to cents per ORDER ROW to make each row read as money:
--
--     round(a.alloc_packaging, 2) as packaging_cost
--
--   Every consumer then inherits that rounding, including SUM(). Over 432 rows
--   the drift is a few tens of cents, and it is invisible: the report looks
--   internally consistent and simply disagrees with the billing screen.
--   The app already formats money at display (lib/format.ts formatCurrency), so
--   the rounding was solving a presentation problem in the data layer.
--
-- SECOND, SUBTLER BUG — the rounding was not even self-consistent. Components
--   were each rounded, but the totals were computed from the UNROUNDED values
--   and rounded once:
--
--     round(alloc_packaging, 2)                                 as packaging_cost
--     round(product_cogs + alloc_packaging + alloc_shipping, 2)  as landed_cost
--
--   so a row's displayed packaging + shipping + COGS could miss its displayed
--   landed_cost by a cent, at random. Anyone auditing a single order would find
--   it and stop trusting the report.
--
-- FIX. Drop all four round() calls. The view returns full precision; the UI
--   rounds when it renders. Totals become exact and every row adds up.
--
-- WHY BILLING IS DIFFERENT, and deliberately not changed: billing_charges.amount
--   is numeric(12,2) because a charge IS a discrete money amount — that is what
--   was invoiced and what the brand pays. Rounding a value at the moment it
--   becomes a fact is correct. Rounding a derived ratio before it is summed is
--   lossy. Same reason storefront_fulfillment_cost keeps raw packaging_cost and
--   only rounds total_reimbursable, which is the figure actually billed.
--
-- SCOPE. Reporting-only, no data written, no behaviour change beyond precision.
--   landed_margin_report has exactly one consumer, app/(app)/reports/page.tsx.
--   Migration 0030 mentions it only in a comment. Every Overview figure shifts
--   by at most a cent per row; the visible change is that Overview's packaging
--   now agrees with Brand billing except for genuine date-boundary orders
--   (Overview keys on sale_date, billing on fulfillment date).
--
-- Reverse with rollback/20260806000089_landed_margin_full_precision.down.sql,
-- which restores the rounded 0027 definition verbatim.
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
       -- FULL PRECISION from here down. Do not reintroduce round() — the caller
       -- formats for display, and rounding here corrupts every SUM() built on
       -- this view. See the header for the $0.41 that prompted this.
       coalesce(a.alloc_packaging, 0)                            as packaging_cost,
       coalesce(a.alloc_shipping, 0)                             as shipping_cost,
       -- Fully-landed cost basis: product + allocated packaging + shipping.
       c.product_cogs
         + coalesce(a.alloc_packaging, 0)
         + coalesce(a.alloc_shipping, 0)                         as landed_cost,
       c.gross_profit,
       -- Net (landed) profit: product gross profit less allocated overheads.
       c.gross_profit
         - coalesce(a.alloc_packaging, 0)
         - coalesce(a.alloc_shipping, 0)                         as net_profit
from public.cogs_report c
left join order_alloc a on a.order_id = c.order_id;

comment on view public.landed_margin_report is
  'Order-grain fully-landed margin for fulfilled orders. Extends cogs_report by allocating each fulfillment group''s packaging + shipping cost across its non-cancelled orders by revenue share (equal split when group revenue is 0). landed_cost = product COGS + allocated packaging + allocated shipping; net_profit = product gross_profit - allocated packaging - shipping. Values are FULL PRECISION — the allocated share is a derived ratio, so callers must format for display rather than the view rounding, otherwise aggregates inherit per-row rounding error (migration 0089). Tax excluded (pass-through).';

grant select on public.landed_margin_report to authenticated;

commit;
