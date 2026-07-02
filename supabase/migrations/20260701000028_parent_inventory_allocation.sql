-- ============================================================================
-- WMS — Migration 0028: parent bulk inventory + client allocation (OrbisTrack)
--
-- Adds the intake/allocation model on top of the existing per-child inventory:
--   * child SKUs gain a WEIGHT dimension (grams_per_unit + variant_label) so a
--     single parent (strain) can have 3.5g / 7g / 14g / 28g sellable jars PER
--     client. The old "one child per product per site" uniqueness is relaxed to
--     allow multiple weight variants while still blocking accidental duplicates.
--   * parent_inventory  — bulk grams pool per (product, site). Intake credits it;
--                         allocation debits it. "Parent available" = on_hand_grams.
--   * parent_inventory_ledger — append-only movement log; levels never drift.
--   * allocations / allocation_lines — one record per "Save Allocation" (who,
--     when, how much per child), for history + the completion screen.
--   * to_grams(qty, uom) — single source of truth for UoM conversion, using the
--     operational convention 1 oz = 28 g, 1 lb = 448 g (kg/g exact).
--   * _parent_inv_lock / _parent_inv_write — locked-row + ledger primitives
--     (SECURITY DEFINER), mirroring the sellable-inventory and packaging designs.
--
-- Shape deliberately mirrors migrations 0002 (inventory) and 0025 (packaging):
-- materialized level + append-only ledger, guarded writers, "locked door" RLS.
--
-- Client = Site (decision D1): allocation groups children by site; no new client
-- entity. Parent pool is per warehouse/site (decision D2).
--
-- The intake_receive / allocate_parent_stock RPCs are migration 0029 (A2). This
-- migration is structure + primitives only, so the risky orchestration gets its
-- own tested migration.
--
-- Reverse with rollback/20260701000028_parent_inventory_allocation.down.sql.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. UoM conversion — one immutable helper the whole app shares.
--    Operational convention (confirmed): 1 oz = 28 g, 1 lb = 448 g. kg/g exact.
-- ----------------------------------------------------------------------------
create or replace function public.to_grams(p_qty numeric, p_uom text)
returns numeric
language plpgsql immutable as $$
declare v_factor numeric;
begin
  if p_qty is null then
    raise exception 'to_grams: quantity is required';
  end if;
  v_factor := case lower(btrim(coalesce(p_uom, '')))
    when 'g'     then 1
    when 'gram'  then 1
    when 'grams' then 1
    when 'oz'    then 28
    when 'ounce' then 28
    when 'lb'    then 448
    when 'lbs'   then 448
    when 'pound' then 448
    when 'kg'    then 1000
    else null
  end;
  if v_factor is null then
    raise exception 'to_grams: unsupported unit of measure %', coalesce(p_uom, '(null)')
      using errcode = 'check_violation';
  end if;
  return p_qty * v_factor;
end;
$$;

comment on function public.to_grams(numeric, text) is
  'Convert a quantity to grams. Convention: 1 oz = 28 g, 1 lb = 448 g, 1 kg = 1000 g.';

-- ----------------------------------------------------------------------------
-- 2. Child SKU weight dimension.
--    grams_per_unit null = a non-cannabis child (behaves as before). For weight
--    variants it carries the jar size (3.5 / 7 / 14 / 28). variant_label is the
--    display string ("3.5g").
-- ----------------------------------------------------------------------------
alter table public.child_skus
  add column if not exists grams_per_unit numeric(8,2)
    check (grams_per_unit is null or grams_per_unit > 0),
  add column if not exists variant_label  text;

-- Relax the old "one child per product per site" rule so multiple weight
-- variants can coexist, WITHOUT losing the guard against true duplicates.
-- COALESCE folds the null (non-weight) case to a single sentinel, preserving
-- "at most one non-weight child per product per site" while allowing many
-- distinct weights. Replaces the inline unique(product_id, site_id).
alter table public.child_skus
  drop constraint if exists child_skus_product_id_site_id_key;
create unique index if not exists child_skus_product_site_variant_key
  on public.child_skus (product_id, site_id, coalesce(grams_per_unit, -1));

-- ----------------------------------------------------------------------------
-- 3. Parent bulk inventory — grams per (product, site). Mirrors packaging_levels.
--    on_hand_grams = unallocated bulk remaining (this is "Parent available").
--    allocated_grams = cumulative allocated, kept for reporting; NOT subtracted
--    again from on_hand.
-- ----------------------------------------------------------------------------
create table public.parent_inventory (
  product_id      uuid not null references public.products(id) on delete cascade,
  site_id         uuid not null references public.sites(id)    on delete cascade,
  on_hand_grams   numeric(12,2) not null default 0,
  allocated_grams numeric(12,2) not null default 0,
  updated_at      timestamptz not null default now(),
  primary key (product_id, site_id),
  check (on_hand_grams   >= 0),
  check (allocated_grams >= 0)
);
create index parent_inventory_site_idx on public.parent_inventory(site_id);

-- Append-only movement log, paired with every level change.
create table public.parent_inventory_ledger (
  id             uuid primary key default gen_random_uuid(),
  product_id     uuid not null references public.products(id) on delete restrict,
  site_id        uuid not null references public.sites(id)    on delete restrict,
  delta_grams    numeric(12,2) not null,
  reason         text not null check (reason in
                   ('intake','allocation','transfer','correction')),
  reference_type text,          -- e.g. 'allocation', 'manual'
  reference_id   uuid,
  batch_no       text,          -- optional lot/batch captured at intake
  note           text,
  actor          uuid references public.profiles(id),
  created_at     timestamptz not null default now()
);
create index parent_inventory_ledger_key_idx
  on public.parent_inventory_ledger(product_id, site_id, created_at);

-- ----------------------------------------------------------------------------
-- 4. Allocation history. One header per "Save Allocation", lines per child SKU.
-- ----------------------------------------------------------------------------
create table public.allocations (
  id              uuid primary key default gen_random_uuid(),
  product_id      uuid not null references public.products(id) on delete restrict,
  site_id         uuid not null references public.sites(id)    on delete restrict,
  total_grams     numeric(12,2) not null default 0,
  note            text,
  idempotency_key text unique,   -- guards double-submit; null allowed (many nulls ok)
  actor           uuid references public.profiles(id),
  created_at      timestamptz not null default now()
);
create index allocations_key_idx on public.allocations(product_id, site_id, created_at);

create table public.allocation_lines (
  id             uuid primary key default gen_random_uuid(),
  allocation_id  uuid not null references public.allocations(id) on delete cascade,
  child_sku_id   uuid not null references public.child_skus(id)  on delete restrict,
  units          integer not null check (units > 0),
  grams_per_unit numeric(8,2) not null,
  grams          numeric(12,2) not null           -- units * grams_per_unit, snapshotted
);
create index allocation_lines_alloc_idx on public.allocation_lines(allocation_id);
create index allocation_lines_child_idx on public.allocation_lines(child_sku_id);

-- ----------------------------------------------------------------------------
-- 5. Internal primitives (locked-row + ledger writer). SECURITY DEFINER so the
--    guards can't be bypassed once direct table writes are revoked (step 7).
-- ----------------------------------------------------------------------------
-- Lock + fetch the parent level row, creating a zero row on demand (the
-- product x site matrix is sparse — materialize lazily on first movement).
create or replace function public._parent_inv_lock(p_product uuid, p_site uuid)
returns public.parent_inventory
language plpgsql as $$
declare v public.parent_inventory;
begin
  if p_product is null or p_site is null then
    raise exception '_parent_inv_lock: product and site are required';
  end if;
  insert into public.parent_inventory(product_id, site_id)
  values (p_product, p_site)
  on conflict (product_id, site_id) do nothing;

  select * into v from public.parent_inventory
   where product_id = p_product and site_id = p_site
   for update;
  return v;
end;
$$;

-- Apply a grams delta (and optional allocated bump) and record the ledger row.
-- Assumes the caller locked the row and validated the transition.
create or replace function public._parent_inv_write(
  p_product uuid, p_site uuid,
  p_delta_grams     numeric,        -- signed change to on_hand_grams
  p_delta_allocated numeric,        -- signed change to allocated_grams (reporting)
  p_reason text, p_ref_type text, p_ref_id uuid, p_batch_no text, p_note text
) returns public.parent_inventory
language plpgsql as $$
declare v public.parent_inventory;
begin
  update public.parent_inventory
     set on_hand_grams   = on_hand_grams   + p_delta_grams,
         allocated_grams = allocated_grams + coalesce(p_delta_allocated, 0),
         updated_at      = now()
   where product_id = p_product and site_id = p_site
   returning * into v;

  insert into public.parent_inventory_ledger(
    product_id, site_id, delta_grams, reason,
    reference_type, reference_id, batch_no, note, actor)
  values (p_product, p_site, p_delta_grams, p_reason,
    p_ref_type, p_ref_id, p_batch_no, p_note, auth.uid());

  return v;
end;
$$;

-- ----------------------------------------------------------------------------
-- 6. Audit + updated_at triggers (same generic helpers as the rest of the schema).
-- ----------------------------------------------------------------------------
create trigger parent_inventory_audit
  after insert or update or delete on public.parent_inventory
  for each row execute function public.audit_row();
create trigger parent_inventory_ledger_audit
  after insert on public.parent_inventory_ledger
  for each row execute function public.audit_row();
create trigger allocations_audit
  after insert or update or delete on public.allocations
  for each row execute function public.audit_row();
create trigger allocation_lines_audit
  after insert or update or delete on public.allocation_lines
  for each row execute function public.audit_row();

create trigger parent_inventory_set_updated_at
  before update on public.parent_inventory
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 7. RLS + the "locked door": reads scoped by site; writes only via the
--    SECURITY DEFINER functions above (mirrors migrations 0003/0011/0025).
-- ----------------------------------------------------------------------------
alter table public.parent_inventory        enable row level security;
alter table public.parent_inventory_ledger enable row level security;
alter table public.allocations             enable row level security;
alter table public.allocation_lines        enable row level security;

create policy parent_inventory_read on public.parent_inventory
  for select using (public.can_access_site(site_id));
create policy parent_inventory_ledger_read on public.parent_inventory_ledger
  for select using (public.can_access_site(site_id));
create policy allocations_read on public.allocations
  for select using (public.can_access_site(site_id));
-- allocation_lines inherit access from their header's site.
create policy allocation_lines_read on public.allocation_lines
  for select using (exists (
    select 1 from public.allocations a
     where a.id = allocation_lines.allocation_id
       and public.can_access_site(a.site_id)));

grant select on public.parent_inventory        to authenticated;
grant select on public.parent_inventory_ledger to authenticated;
grant select on public.allocations             to authenticated;
grant select on public.allocation_lines        to authenticated;

-- Revoke direct writes (0011's default-privileges auto-grant would otherwise
-- hand them to authenticated) so levels/history change only through guards/RPCs.
do $$
declare r text; t text;
begin
  foreach t in array array[
    'parent_inventory','parent_inventory_ledger','allocations','allocation_lines'
  ] loop
    execute format('revoke insert, update, delete on public.%I from public', t);
    foreach r in array array['authenticated','anon','app_user'] loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke insert, update, delete on public.%I from %I', t, r);
      end if;
    end loop;
  end loop;
end $$;

-- Promote the primitives to definer and seal them from the API roles.
alter function public._parent_inv_lock(uuid,uuid) security definer set search_path = '';
alter function public._parent_inv_write(uuid,uuid,numeric,numeric,text,text,uuid,text,text)
  security definer set search_path = '';

revoke execute on function public._parent_inv_lock(uuid,uuid) from public;
revoke execute on function public._parent_inv_write(uuid,uuid,numeric,numeric,text,text,uuid,text,text) from public;
do $$
declare r text;
begin
  foreach r in array array['authenticated','anon','app_user'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke execute on function public._parent_inv_lock(uuid,uuid) from %I', r);
      execute format('revoke execute on function public._parent_inv_write(uuid,uuid,numeric,numeric,text,text,uuid,text,text) from %I', r);
    end if;
  end loop;
end $$;

-- to_grams is a pure helper — safe for anyone to call.
grant execute on function public.to_grams(numeric, text) to authenticated;

-- ----------------------------------------------------------------------------
-- 8. Reporting: parent bulk on-hand + allocated grams per product per site.
-- ----------------------------------------------------------------------------
create view public.parent_inventory_report with (security_invoker = true) as
select pi.product_id,
       p.name          as product_name,
       pi.site_id,
       s.name          as site_name,
       pi.on_hand_grams  as available_grams,
       pi.allocated_grams,
       pi.updated_at
from public.parent_inventory pi
join public.products p on p.id = pi.product_id
join public.sites    s on s.id = pi.site_id;

comment on view public.parent_inventory_report is
  'Per-site parent bulk inventory: available (unallocated) grams and cumulative allocated grams. Reads scoped by parent_inventory RLS (can_access_site).';

grant select on public.parent_inventory_report to authenticated;

commit;
