-- ============================================================================
-- WMS — Migration 0032: parent/weight fields on inventory_report
--
-- The inventory screen is a flat one-row-per-child list. To group it by parent
-- SKU (parent -> site -> weight) the display needs three fields the view did
-- not expose: the parent product_id it belongs to, and the weight
-- (grams_per_unit / variant_label) that distinguishes children of the same
-- parent. price + bin_location are added too so the grouped screen can show the
-- relevant per-child info in one place.
--
-- This is a pure additive reporting change. Columns are appended at the END so
-- `create or replace view` succeeds without dropping the view (no dependent
-- objects break, no data touched). Reverse with the matching down migration.
-- ============================================================================

begin;

create or replace view public.inventory_report with (security_invoker = true) as
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
       -- 0032: grouping + display fields (appended)
       cs.product_id,
       cs.grams_per_unit,
       cs.variant_label,
       cs.price,
       cs.bin_location
from public.child_skus cs
join public.sites s            on s.id  = cs.site_id
join public.products p         on p.id  = cs.product_id
join public.inventory_levels il on il.child_sku_id = cs.id;

commit;
