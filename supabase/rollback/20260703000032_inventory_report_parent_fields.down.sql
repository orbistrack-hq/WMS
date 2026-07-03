-- Rollback 0032: restore inventory_report to its pre-0032 column set.
-- `create or replace view` cannot DROP columns, so drop + recreate. No object
-- depends on the added columns, so this is safe.
begin;

drop view if exists public.inventory_report;

create view public.inventory_report with (security_invoker = true) as
select cs.id            as child_sku_id,
       cs.site_id,
       s.name           as site_name,
       p.name           as product_name,
       cs.sku,
       il.on_hand,
       il.available,
       il.reserved,
       il.layby,
       cs.cost,
       (il.on_hand * cs.cost) as value_at_cost
from public.child_skus cs
join public.sites s            on s.id  = cs.site_id
join public.products p         on p.id  = cs.product_id
join public.inventory_levels il on il.child_sku_id = cs.id;

grant select on public.inventory_report to authenticated;

commit;
