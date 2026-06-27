-- WMS — Migration 0022: DOWN
begin;

drop function if exists public.merge_products(uuid, uuid[], boolean);

-- Restore product_merge_log to its 0021 shape. (Manual rows, if any, lose their
-- kind/merged_by metadata; auto rows are unaffected.)
alter table public.product_merge_log drop column if exists merged_by;
alter table public.product_merge_log drop column if exists kind;
-- Re-impose NOT NULL only if no manual (null-sku) rows remain.
update public.product_merge_log set sku = '' where sku is null;
alter table public.product_merge_log alter column sku set not null;

commit;
