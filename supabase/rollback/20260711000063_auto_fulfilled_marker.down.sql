-- Rollback 0063: remove the auto_fulfilled marker and restore the pre-0063 state
-- (migration 0041 fulfill_order signature + migration 0062 packaging-gap view).

begin;

-- 1. Restore the 0062 view first (it references o.auto_fulfilled). CREATE OR
--    REPLACE can't drop a column, so drop and recreate without auto_fulfilled.
drop view if exists public.orders_missing_packaging;

create view public.orders_missing_packaging with (security_invoker = true) as
select
  o.id            as order_id,
  o.order_number,
  o.site_id,
  s.name          as site_name,
  o.customer_id,
  c.name          as customer_name,
  o.channel,
  o.order_type,
  o.group_id,
  o.entered_at,
  o.sale_date,
  o.fulfilled_at,
  coalesce(li.line_count, 0)  as line_count,
  coalesce(li.unit_count, 0)  as unit_count,
  coalesce(li.order_value, 0) as order_value,
  gc.group_order_count
from public.orders o
join public.sites s on s.id = o.site_id
left join public.customers c on c.id = o.customer_id
left join lateral (
  select count(*)      as line_count,
         sum(quantity) as unit_count,
         sum(quantity * unit_price - coalesce(discount,0) + coalesce(tax,0)) as order_value
    from public.order_line_items
   where order_id = o.id
) li on true
left join lateral (
  select count(*) as group_order_count
    from public.orders og
   where og.group_id = o.group_id
) gc on true
where o.status = 'fulfilled'
  and o.channel in ('shopify','woocommerce')
  and not exists (
    select 1 from public.packaging_usage pu where pu.group_id = o.group_id
  );

grant select on public.orders_missing_packaging to authenticated;

-- 2. Restore the 0041 fulfill_order (2-arg, no auto_fulfilled reference).
drop function if exists public.fulfill_order(uuid, timestamptz, boolean);

create or replace function public.fulfill_order(
  p_order_id     uuid,
  p_fulfilled_at timestamptz default null
)
returns public.orders language plpgsql as $$
declare
  v    public.orders;
  v_at timestamptz := coalesce(p_fulfilled_at, now());
begin
  select * into v from public.orders where id = p_order_id for update;
  if not found then raise exception 'Order % not found', p_order_id; end if;
  if v.status = 'fulfilled' then raise exception 'Order % already fulfilled', p_order_id; end if;
  if v.status = 'cancelled' then raise exception 'Order % is cancelled and cannot be fulfilled', p_order_id; end if;
  if v.status = 'returned' then raise exception 'Order % is returned; re-open it before fulfilling', p_order_id; end if;

  update public.orders set status = 'fulfilled', fulfilled_at = v_at
   where id = p_order_id returning * into v;
  perform public.apply_order_fulfillment(p_order_id);
  perform public.charge_order_pick_fee(p_order_id);

  update public.fulfillment_groups g set status = 'fulfilled', fulfilled_at = v_at
   where g.id = v.group_id
     and not exists (select 1 from public.orders o where o.group_id = g.id and o.status <> 'fulfilled');
  return v;
end;
$$;

grant execute on function public.fulfill_order(uuid, timestamptz) to authenticated;

-- 3. Now the column is unreferenced — drop it.
alter table public.orders drop column if exists auto_fulfilled;

commit;
