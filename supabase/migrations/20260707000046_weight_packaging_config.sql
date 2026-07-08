-- ============================================================================
-- WMS — Migration 0046: weight → packaging map + per-order defaults (FB-6)
--
-- Packaging cost now varies by BOTH weight and bag dimension, so the single
-- jar/bag threshold (migration 0040) isn't enough. This adds:
--   * a new 'mylar_bag' kind (the per-ITEM bag, distinct from the per-ORDER
--     vacuum sealed bag);
--   * packaging_weight_rule — maps an EXACT per-unit weight to a specific
--     packaging type + qty (so 7g and 14g use different-sized Mylar bags with
--     different costs);
--   * packaging_order_default — packaging every order gets once (box, label,
--     vacuum bag), counted per group.
--
-- Both are managed by the ops team (is_operator, matching FB-7) and read by any
-- signed-in user. Canonical types + rules + defaults are baked in here (fixed
-- ids, on-conflict-do-nothing) so every client instance gets the correct config
-- out of the box; costs stay editable in Settings → Packaging.
--
-- Confirmed costs (J, 2026-07-08): vacuum bag $0.50 (1 per order), Mylar 7g
-- (4x6x2) $0.12, Mylar 14g & 28g (6x9x3) $0.20, box $0.45, label $0.03,
-- 3.5g → jar. Exact-weight match.
--
-- Reverse with rollback/20260707000046_weight_packaging_config.down.sql.
-- ============================================================================

begin;

-- ---- 1. New kind: mylar_bag ------------------------------------------------
alter table public.packaging_types drop constraint packaging_types_kind_check;
alter table public.packaging_types add constraint packaging_types_kind_check
  check (kind in
    ('box','shipping_label','jar','jar_label','vacuum_bag','mylar_bag','custom'));

-- ---- 2. Config tables ------------------------------------------------------
-- Per-unit: an exact grams_per_unit maps to a packaging type + qty per unit.
create table public.packaging_weight_rule (
  id                uuid primary key default gen_random_uuid(),
  grams_per_unit    numeric(8,2) not null check (grams_per_unit > 0),
  packaging_type_id uuid not null references public.packaging_types(id) on delete cascade,
  qty_per_unit      integer not null default 1 check (qty_per_unit > 0),
  updated_at        timestamptz not null default now(),
  updated_by        uuid references public.profiles(id),
  unique (grams_per_unit, packaging_type_id)
);
create index packaging_weight_rule_grams_idx
  on public.packaging_weight_rule(grams_per_unit);

-- Per-order: packaging every order gets once (counted per fulfillment group).
create table public.packaging_order_default (
  id                uuid primary key default gen_random_uuid(),
  packaging_type_id uuid not null unique references public.packaging_types(id) on delete cascade,
  qty               integer not null default 1 check (qty > 0),
  updated_at        timestamptz not null default now(),
  updated_by        uuid references public.profiles(id)
);

-- ---- 3. RLS: read = any signed-in; manage = ops team (is_operator) ----------
alter table public.packaging_weight_rule    enable row level security;
alter table public.packaging_order_default  enable row level security;

create policy packaging_weight_rule_read on public.packaging_weight_rule
  for select using (auth.uid() is not null);
create policy packaging_weight_rule_manage on public.packaging_weight_rule
  for all using (public.is_operator()) with check (public.is_operator());

create policy packaging_order_default_read on public.packaging_order_default
  for select using (auth.uid() is not null);
create policy packaging_order_default_manage on public.packaging_order_default
  for all using (public.is_operator()) with check (public.is_operator());

grant select, insert, update, delete on public.packaging_weight_rule   to authenticated;
grant select, insert, update, delete on public.packaging_order_default to authenticated;

-- ---- 4. Triggers (timestamp + audit) ---------------------------------------
create trigger packaging_weight_rule_set_updated_at
  before update on public.packaging_weight_rule
  for each row execute function public.set_updated_at();
create trigger a_packaging_weight_rule
  after insert or update or delete on public.packaging_weight_rule
  for each row execute function public.audit_row();

create trigger packaging_order_default_set_updated_at
  before update on public.packaging_order_default
  for each row execute function public.set_updated_at();
create trigger a_packaging_order_default
  after insert or update or delete on public.packaging_order_default
  for each row execute function public.audit_row();

-- ---- 5. Canonical types (shared; fixed ids; idempotent) --------------------
insert into public.packaging_types (id, name, kind, unit_cost, site_id) values
  ('fb600000-0000-0000-0000-0000000000b1','Box','box',0.45,null),
  ('fb600000-0000-0000-0000-0000000000e1','Label','shipping_label',0.03,null),
  ('fb600000-0000-0000-0000-0000000000a1','3.5g Jar','jar',0.40,null),
  ('fb600000-0000-0000-0000-0000000000a2','Jar Label','jar_label',0.03,null),
  ('fb600000-0000-0000-0000-0000000000f1','Vacuum Sealed Bag','vacuum_bag',0.50,null),
  ('fb600000-0000-0000-0000-0000000000c1','Mylar Bag 4x6x2 (7g)','mylar_bag',0.12,null),
  ('fb600000-0000-0000-0000-0000000000c2','Mylar Bag 6x9x3 (14/28g)','mylar_bag',0.20,null)
on conflict (id) do nothing;

-- ---- 6. Weight rules (exact grams → type × qty per unit) -------------------
insert into public.packaging_weight_rule (grams_per_unit, packaging_type_id, qty_per_unit) values
  (3.5, 'fb600000-0000-0000-0000-0000000000a1', 1),   -- 3.5g → jar
  (3.5, 'fb600000-0000-0000-0000-0000000000a2', 1),   -- 3.5g → jar label
  (7,   'fb600000-0000-0000-0000-0000000000c1', 1),   -- 7g   → Mylar 4x6x2
  (14,  'fb600000-0000-0000-0000-0000000000c2', 1),   -- 14g  → Mylar 6x9x3
  (28,  'fb600000-0000-0000-0000-0000000000c2', 1)    -- 28g  → Mylar 6x9x3
on conflict (grams_per_unit, packaging_type_id) do nothing;

-- ---- 7. Per-order defaults (once per order/group) --------------------------
insert into public.packaging_order_default (packaging_type_id, qty) values
  ('fb600000-0000-0000-0000-0000000000b1', 1),   -- box
  ('fb600000-0000-0000-0000-0000000000e1', 1),   -- label
  ('fb600000-0000-0000-0000-0000000000f1', 1)    -- vacuum sealed bag (always)
on conflict (packaging_type_id) do nothing;

comment on table public.packaging_weight_rule is
  'Exact per-unit weight (grams_per_unit) → packaging type + qty per unit (FB-6). Lets different weights use different-sized/cost Mylar bags. Ops-managed, read by all.';
comment on table public.packaging_order_default is
  'Packaging every order gets once (box, label, vacuum bag), counted per fulfillment group (FB-6). Ops-managed, read by all.';

commit;
