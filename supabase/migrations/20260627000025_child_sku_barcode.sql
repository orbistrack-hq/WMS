-- ============================================================================
-- WMS — Migration 0025: scannable barcode on child SKUs
--
-- A SKU code is an internal identifier; the scannable label (UPC/EAN) is often
-- a different number. Storing it explicitly lets scan-to-pick and scan-to-pack
-- match a scan against barcode FIRST, then fall back to the SKU code, without
-- overloading the sku column.
--
-- Free text, nullable: not every SKU has a barcode yet. The (site_id, barcode)
-- index keeps scan lookups fast as labels are filled in. Existing RLS/grants on
-- child_skus already cover the new column.
-- ============================================================================

begin;

alter table public.child_skus
  add column if not exists barcode text;

create index if not exists child_skus_barcode_idx
  on public.child_skus (site_id, barcode);

comment on column public.child_skus.barcode is
  'Scannable label (UPC/EAN). Matched before the SKU code during scan-to-pick / scan-to-pack; blank means no barcode on file.';

commit;
