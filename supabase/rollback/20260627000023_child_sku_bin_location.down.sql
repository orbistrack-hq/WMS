-- WMS — Migration 0023: DOWN
begin;

drop index if exists public.child_skus_bin_idx;

alter table public.child_skus
  drop column if exists bin_location;

commit;
