-- ============================================================================
-- WMS — Migration 0023: bin / location tracking on child SKUs
--
-- Pickers had no location data, so the pick list fell back to alphabetical-by-
-- SKU order — a scavenger hunt rather than a walking route. A child SKU is
-- already one product at one site, so its physical pick location belongs on it.
--
-- Free-text (e.g. "A-12-3") is enough for v1: one bin per child SKU, no
-- structured aisle/shelf table yet. Existing RLS/grants on child_skus already
-- cover the new column. The (site_id, bin_location) index keeps the route sort
-- on the pick list cheap as bins fill in.
-- ============================================================================

begin;

alter table public.child_skus
  add column if not exists bin_location text;

create index if not exists child_skus_bin_idx
  on public.child_skus (site_id, bin_location);

comment on column public.child_skus.bin_location is
  'Free-text pick location (e.g. "A-12-3"). Sorts the pick list into a walking route; blank means unassigned.';

commit;
