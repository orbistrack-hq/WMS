-- Diagnostic only — safe, none of these execute the slow report itself.
-- Goal: find out what's different about the last-30/90-day window that
-- makes it slow when 8/1-8/24 (a similar-sized window) is fine.

-- 1. Compare planned cost for the failing window vs the working one.
explain select * from public.landed_margin_report((current_date - 30)::date, current_date::date);
explain select * from public.landed_margin_report('2026-08-01'::date, '2026-08-24'::date);

-- 2. Any single date with an abnormal order count in the failing window?
--    (e.g. a bulk import or seed/test batch, same pattern as audit_log)
select sale_date, count(*) as order_count
from public.orders
where status = 'fulfilled'
  and sale_date between current_date - 30 and current_date
group by sale_date
order by order_count desc
limit 15;

-- 3. Any single fulfillment group with an outlier number of orders? A
--    "mega group" would inflate order_rev's row count on its own, even if
--    the total number of DISTINCT groups in the window is unremarkable.
select o.group_id, count(*) as orders_in_group
from public.orders o
where o.status <> 'cancelled'
  and o.group_id in (
    select group_id from public.orders
    where status = 'fulfilled' and sale_date between current_date - 30 and current_date
  )
group by o.group_id
order by orders_in_group desc
limit 15;

-- 4. Same check against packaging_usage — a group with a huge number of
--    packaging rows would blow up group_pack for that one group alone.
select group_id, count(*) as packaging_rows
from public.packaging_usage
where group_id in (
  select group_id from public.orders
  where status = 'fulfilled' and sale_date between current_date - 30 and current_date
)
group by group_id
order by packaging_rows desc
limit 15;
