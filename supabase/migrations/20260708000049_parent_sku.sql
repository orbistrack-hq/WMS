-- ============================================================================
-- WMS — Migration 0047: parent (product) SKU code  [FB-8]
--
-- The "parent" is a products row identified only by its name; it has never had
-- a SKU code of its own (only child_skus.sku exists). Operators want a short,
-- WMS-only code to manage a strain parent alongside its name — e.g. child SKU
-- "TSU-AF3.5G" rolls up to a parent they think of as "AF".
--
-- This adds a free-text parent code. It is WMS-only: the store sync writers
-- (upsert_store_weight_variant / upsert_shopify_variant, migrations 0020/0030)
-- only ever touch products.name, never this column, so a code entered here is
-- never overwritten by a re-sync. Optional and independent of child_skus.sku;
-- not uniqueness-constrained (parents can legitimately share, and existing rows
-- start NULL). Existing RLS/grants on products already cover the new column.
--
-- Reverse with rollback/20260708000047_parent_sku.down.sql.
-- ============================================================================

begin;

alter table public.products
  add column if not exists sku text;

comment on column public.products.sku is
  'WMS-only parent/strain code (e.g. "AF"), shown alongside the product name for management. Never written by store sync; optional, non-unique, independent of child_skus.sku.';

-- Cheap lookup for the "search by parent code" path on catalog / by-parent.
create index if not exists products_sku_idx
  on public.products (sku) where sku is not null;

commit;
