-- ============================================================================
-- WMS — Migration 0080: per-child-SKU packaging override (FB-6 extension)
--
-- The weight→packaging map (migration 0046) keys packaging purely on a child
-- SKU's exact grams_per_unit. That can't distinguish two products of the SAME
-- weight that need DIFFERENT packaging — e.g. a normal 3.5g eighth goes in a jar,
-- but a promotional "free eighth" ships in a 7g Mylar bag. Weight alone is blind
-- to that.
--
-- This adds packaging_sku_rule: a per-child-SKU override that REPLACES the
-- weight-derived per-unit packaging for that SKU's units. When a unit's child
-- SKU has any override row, the compute engine uses those rows for that unit and
-- skips the weight rule entirely; per-ORDER defaults (box, label, vacuum bag)
-- still apply once per group as before. A SKU with no override behaves exactly as
-- today. Because it keys on the child SKU (not weight), it also gives packaging
-- to override SKUs that have no weight set at all.
--
-- Like packaging_weight_rule / packaging_order_default: read by any signed-in
-- user (the packing/wave screens read it), managed by the ops team (is_operator),
-- and stamped + audited by the shared 0001 triggers. It is still a SEED — the
-- packer can override any pre-filled number before confirming.
--
-- Seed: every child SKU of the four current "free eighth" parent products is
-- mapped to the shared 7g Mylar bag (4x6x2, type c1 from migration 0046). Done
-- as an insert-select on product_id so all per-site children are covered without
-- hardcoding child ids. Idempotent (on conflict do nothing). If those products
-- are later merged, or new children are added, manage them in Settings →
-- Packaging → "Specific SKU packaging".
--
-- Reverse with rollback/20260722000080_packaging_sku_rule.down.sql.
-- ============================================================================

begin;

-- ---- 1. Override table -----------------------------------------------------
-- One (or more) packaging types per child SKU. A uuid PK keeps the shared
-- audit_row() trigger happy (it casts record_id to uuid). unique(child, type)
-- allows several packaging types for one SKU while preventing exact duplicates.
create table public.packaging_sku_rule (
  id                uuid primary key default gen_random_uuid(),
  child_sku_id      uuid not null references public.child_skus(id) on delete cascade,
  packaging_type_id uuid not null references public.packaging_types(id) on delete cascade,
  qty_per_unit      integer not null default 1 check (qty_per_unit > 0),
  updated_at        timestamptz not null default now(),
  updated_by        uuid references public.profiles(id),
  unique (child_sku_id, packaging_type_id)
);
create index packaging_sku_rule_child_idx
  on public.packaging_sku_rule(child_sku_id);

-- ---- 2. RLS: read = any signed-in; manage = ops team (is_operator) ---------
alter table public.packaging_sku_rule enable row level security;

create policy packaging_sku_rule_read on public.packaging_sku_rule
  for select using (auth.uid() is not null);
create policy packaging_sku_rule_manage on public.packaging_sku_rule
  for all using (public.is_operator()) with check (public.is_operator());

grant select, insert, update, delete on public.packaging_sku_rule to authenticated;

-- ---- 3. Triggers (timestamp + audit) ---------------------------------------
create trigger packaging_sku_rule_set_updated_at
  before update on public.packaging_sku_rule
  for each row execute function public.set_updated_at();
create trigger a_packaging_sku_rule
  after insert or update or delete on public.packaging_sku_rule
  for each row execute function public.audit_row();

comment on table public.packaging_sku_rule is
  'Per-child-SKU packaging override (FB-6 extension): a child SKU listed here uses THESE packaging types per unit instead of its weight-derived packaging. Per-order defaults still apply. Ops-managed, read by all. A seed the packer can still override.';

-- ---- 4. Seed the four "free eighth" products to the 7g Mylar bag ------------
-- Insert-select on the current parent product ids so every per-site child is
-- covered without hardcoding child ids. c1 = shared 'Mylar Bag 4x6x2 (7g)'.
insert into public.packaging_sku_rule (child_sku_id, packaging_type_id, qty_per_unit)
select cs.id, 'fb600000-0000-0000-0000-0000000000c1'::uuid, 1
from public.child_skus cs
where cs.product_id in (
  '83f959c7-fcf8-4eaf-8577-0c3f001568fa',  -- BudClub Reward Free 1G
  '0a712546-5308-41a5-8d54-31bea642848d',  -- FREE 1/8 GIFT
  'de9fcc82-6058-4628-83e4-3d9d49074de9',  -- FREE 1/8 GIFT
  '917590b5-94a7-4bb2-804c-4bf9a52b7afb'   -- Free Top Shelf (3.5G) Eighth!
)
on conflict (child_sku_id, packaging_type_id) do nothing;

commit;
