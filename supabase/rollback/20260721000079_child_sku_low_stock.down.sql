-- Rollback 0079: remove child-SKU low-stock alerts.
-- Restore inventory_report to its 0032 column set (drop + recreate, since
-- create-or-replace cannot drop columns), drop the RPCs + column + settings
-- table. No object depends on the added columns, so this is safe.
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
       (il.on_hand * cs.cost) as value_at_cost,
       cs.product_id,
       cs.grams_per_unit,
       cs.variant_label,
       cs.price,
       cs.bin_location
from public.child_skus cs
join public.sites s             on s.id  = cs.site_id
join public.products p          on p.id  = cs.product_id
join public.inventory_levels il on il.child_sku_id = cs.id;

grant select on public.inventory_report to authenticated;

drop function if exists public.set_child_low_stock_threshold(uuid[],integer);
drop function if exists public.set_low_stock_default(integer);
drop function if exists public.low_stock_default();

alter table public.child_skus
  drop constraint if exists child_skus_low_stock_threshold_check;
alter table public.child_skus
  drop column if exists low_stock_threshold;

drop policy if exists app_settings_read on public.app_settings;
drop table if exists public.app_settings;

commit;
