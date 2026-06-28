-- WMS — Migration 0025: DOWN
begin;

drop index if exists public.child_skus_barcode_idx;

alter table public.child_skus
  drop column if exists barcode;

commit;
