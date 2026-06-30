-- ============================================================================
-- WMS — Migration 0025: per-site packaging stock
--
-- packaging_types (box/label/jar/bag/...) carried a unit_cost but no stock
-- count. This migration adds a real, auditable on-hand count for packaging,
-- tracked PER SITE (each location keeps its own jar/box/label/bag counts,
-- consistent with the site isolation that governs sellable inventory).
--
-- Shape mirrors the sellable-inventory design (migrations 0002/0003):
--   * packaging_levels  — materialized on_hand per (packaging_type, site),
--                         plus an optional reorder_point for low-stock alerts.
--   * packaging_ledger  — append-only movement log; levels never drift from it.
--   * _pkg_lock/_pkg_write — locked-row + ledger primitives (SECURITY DEFINER).
--   * receive_packaging / adjust_packaging / set_packaging_reorder_point — the
--     only sanctioned writers; direct table writes are revoked from API roles.
--
-- DELIBERATE TRADE-OFF (forgiving of human error): packaging CONSUMPTION at
-- packing is allowed to drive on_hand NEGATIVE. The packing team ships all day;
-- a packaging mis-count must never block a shipment. A negative on_hand is a
-- visible signal ("used more than was received") and reconciles to zero with a
-- receipt/adjustment. By contrast, a MANUAL adjustment is blocked from making
-- on_hand negative, because that's an operator entering a real counted figure.
--
-- Reverse with rollback/20260630000025_packaging_stock.down.sql.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. Tables
-- ----------------------------------------------------------------------------
-- One materialized count per packaging type per site. on_hand has NO >= 0
-- check on purpose (see header): consumption may legitimately push it negative.
create table public.packaging_levels (
  packaging_type_id uuid not null references public.packaging_types(id) on delete cascade,
  site_id           uuid not null references public.sites(id)           on delete cascade,
  on_hand           integer not null default 0,
  reorder_point     integer check (reorder_point is null or reorder_point >= 0),
  updated_at        timestamptz not null default now(),
  primary key (packaging_type_id, site_id)
);
create index packaging_levels_site_idx on public.packaging_levels(site_id);

-- Append-only movement log, paired with every level change.
create table public.packaging_ledger (
  id                uuid primary key default gen_random_uuid(),
  packaging_type_id uuid not null references public.packaging_types(id) on delete restrict,
  site_id           uuid not null references public.sites(id)           on delete restrict,
  delta_on_hand     integer not null,
  reason            text not null check (reason in (
                      'receipt','manual_adjustment','consume','consume_reversal','correction')),
  reference_type    text,        -- e.g. 'packaging_usage', 'manual'
  reference_id      uuid,
  note              text,
  actor             uuid references public.profiles(id),
  created_at        timestamptz not null default now()
);
create index packaging_ledger_type_site_idx
  on public.packaging_ledger(packaging_type_id, site_id, created_at);

-- ----------------------------------------------------------------------------
-- 2. Internal primitives (locked-row + ledger writer). SECURITY DEFINER so the
--    guards can't be bypassed once direct table writes are revoked (step 6).
-- ----------------------------------------------------------------------------
-- Lock + fetch the level row, creating a zero row on demand (the type×site
-- matrix is sparse, so rows are materialized lazily on first movement).
create or replace function public._pkg_lock(p_type uuid, p_site uuid)
returns public.packaging_levels
language plpgsql as $$
declare v public.packaging_levels;
begin
  if p_type is null or p_site is null then
    raise exception '_pkg_lock: packaging type and site are required';
  end if;
  insert into public.packaging_levels(packaging_type_id, site_id)
  values (p_type, p_site)
  on conflict (packaging_type_id, site_id) do nothing;

  select * into v from public.packaging_levels
   where packaging_type_id = p_type and site_id = p_site
   for update;
  return v;
end;
$$;

-- Apply a delta and record the matching ledger row. Assumes the caller locked
-- the row and validated the transition.
create or replace function public._pkg_write(
  p_type uuid, p_site uuid, p_delta integer,
  p_reason text, p_ref_type text, p_ref_id uuid, p_note text
) returns public.packaging_levels
language plpgsql as $$
declare v public.packaging_levels;
begin
  update public.packaging_levels
     set on_hand = on_hand + p_delta, updated_at = now()
   where packaging_type_id = p_type and site_id = p_site
   returning * into v;

  insert into public.packaging_ledger(
    packaging_type_id, site_id, delta_on_hand,
    reason, reference_type, reference_id, note, actor)
  values (p_type, p_site, p_delta,
    p_reason, p_ref_type, p_ref_id, p_note, auth.uid());

  return v;
end;
$$;

-- ----------------------------------------------------------------------------
-- 3. Sanctioned writers
-- ----------------------------------------------------------------------------
-- receive: packaging stock arrives at a site.
create or replace function public.receive_packaging(
  p_type uuid, p_site uuid, p_qty integer, p_note text default null
) returns public.packaging_levels
language plpgsql as $$
begin
  if p_qty is null or p_qty <= 0 then
    raise exception 'receive_packaging: quantity must be positive (got %)', p_qty
      using errcode = 'check_violation';
  end if;
  perform public._pkg_lock(p_type, p_site);
  return public._pkg_write(p_type, p_site, p_qty, 'receipt', 'manual', null, p_note);
end;
$$;

-- adjust: signed manual correction with a required note. Unlike consume, this
-- is blocked from making on_hand negative (an operator enters a real count).
create or replace function public.adjust_packaging(
  p_type uuid, p_site uuid, p_delta integer, p_note text
) returns public.packaging_levels
language plpgsql as $$
declare v public.packaging_levels;
begin
  if p_delta = 0 then
    raise exception 'adjust_packaging: delta must be non-zero';
  end if;
  if p_note is null or length(trim(p_note)) = 0 then
    raise exception 'adjust_packaging: a note is required';
  end if;
  v := public._pkg_lock(p_type, p_site);
  if v.on_hand + p_delta < 0 then
    raise exception 'Adjustment would make packaging on_hand negative: on_hand %, delta %',
      v.on_hand, p_delta using errcode = 'check_violation';
  end if;
  return public._pkg_write(p_type, p_site, p_delta, 'manual_adjustment', 'manual', null, p_note);
end;
$$;

-- set the per-site reorder point (low-stock threshold). Null clears it.
create or replace function public.set_packaging_reorder_point(
  p_type uuid, p_site uuid, p_point integer
) returns public.packaging_levels
language plpgsql as $$
declare v public.packaging_levels;
begin
  if p_point is not null and p_point < 0 then
    raise exception 'set_packaging_reorder_point: reorder point cannot be negative';
  end if;
  perform public._pkg_lock(p_type, p_site);
  update public.packaging_levels
     set reorder_point = p_point, updated_at = now()
   where packaging_type_id = p_type and site_id = p_site
   returning * into v;
  return v;
end;
$$;

-- ----------------------------------------------------------------------------
-- 4. Consumption: decrement at packing, sourced from packaging_usage.
--    packaging_usage already records ONE row per type per fulfillment group, so
--    a combined-order group's box/label is decremented exactly once. The site
--    is the group's site. We mirror inserts (consume), quantity edits (consume
--    the delta), and deletes/removals (reverse). SECURITY DEFINER so the
--    trigger can write the locked packaging tables.
-- ----------------------------------------------------------------------------
create or replace function public.tg_packaging_usage_stock()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_site  uuid;
  v_type  uuid;
  v_delta integer;
begin
  if tg_op = 'INSERT' then
    v_type  := new.packaging_type_id;
    v_delta := -new.quantity;                       -- consume
    select g.site_id into v_site from public.fulfillment_groups g where g.id = new.group_id;
    if v_site is not null and v_delta <> 0 then
      perform public._pkg_lock(v_type, v_site);
      perform public._pkg_write(v_type, v_site, v_delta, 'consume', 'packaging_usage', new.id, null);
    end if;
    return new;

  elsif tg_op = 'UPDATE' then
    -- Type shouldn't change, but handle it defensively: reverse the old type,
    -- consume the new. Otherwise just apply the quantity delta on the same type.
    select g.site_id into v_site from public.fulfillment_groups g where g.id = new.group_id;
    if v_site is null then return new; end if;
    if new.packaging_type_id is distinct from old.packaging_type_id then
      perform public._pkg_lock(old.packaging_type_id, v_site);
      perform public._pkg_write(old.packaging_type_id, v_site, old.quantity,
        'consume_reversal', 'packaging_usage', new.id, 'type changed');
      perform public._pkg_lock(new.packaging_type_id, v_site);
      perform public._pkg_write(new.packaging_type_id, v_site, -new.quantity,
        'consume', 'packaging_usage', new.id, 'type changed');
    else
      v_delta := -(new.quantity - old.quantity);
      if v_delta <> 0 then
        perform public._pkg_lock(new.packaging_type_id, v_site);
        perform public._pkg_write(new.packaging_type_id, v_site, v_delta,
          'consume', 'packaging_usage', new.id, 'quantity edited');
      end if;
    end if;
    return new;

  else  -- DELETE: a packaging line was removed; give the stock back.
    select g.site_id into v_site from public.fulfillment_groups g where g.id = old.group_id;
    if v_site is not null and old.quantity <> 0 then
      perform public._pkg_lock(old.packaging_type_id, v_site);
      perform public._pkg_write(old.packaging_type_id, v_site, old.quantity,
        'consume_reversal', 'packaging_usage', old.id, null);
    end if;
    return old;
  end if;
end;
$$;

create trigger packaging_usage_stock
  after insert or update or delete on public.packaging_usage
  for each row execute function public.tg_packaging_usage_stock();

-- ----------------------------------------------------------------------------
-- 5. Audit triggers (same generic audit_row used by the rest of the schema).
-- ----------------------------------------------------------------------------
create trigger packaging_levels_audit
  after insert or update or delete on public.packaging_levels
  for each row execute function public.audit_row();
create trigger packaging_ledger_audit
  after insert on public.packaging_ledger
  for each row execute function public.audit_row();

create trigger packaging_levels_set_updated_at
  before update on public.packaging_levels
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 6. RLS + the "locked door": reads scoped by site; writes only via the
--    SECURITY DEFINER functions/trigger above (mirrors migrations 0003/0011).
-- ----------------------------------------------------------------------------
alter table public.packaging_levels enable row level security;
alter table public.packaging_ledger enable row level security;

create policy packaging_levels_read on public.packaging_levels
  for select using (public.can_access_site(site_id));
create policy packaging_ledger_read on public.packaging_ledger
  for select using (public.can_access_site(site_id));

grant select on public.packaging_levels to authenticated;
grant select on public.packaging_ledger to authenticated;

-- Revoke direct writes (0011's default-privileges auto-grant would otherwise
-- hand them to authenticated) so levels can only change through the guards.
revoke insert, update, delete on public.packaging_levels from public;
revoke insert, update, delete on public.packaging_ledger from public;
do $$
declare r text;
begin
  foreach r in array array['authenticated','anon','app_user'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke insert, update, delete on public.packaging_levels from %I', r);
      execute format('revoke insert, update, delete on public.packaging_ledger from %I', r);
    end if;
  end loop;
end $$;

-- Promote the primitives to definer and seal them from the API roles.
alter function public._pkg_lock(uuid,uuid)                                    security definer set search_path = '';
alter function public._pkg_write(uuid,uuid,integer,text,text,uuid,text)       security definer set search_path = '';
alter function public.receive_packaging(uuid,uuid,integer,text)              security definer set search_path = '';
alter function public.adjust_packaging(uuid,uuid,integer,text)              security definer set search_path = '';
alter function public.set_packaging_reorder_point(uuid,uuid,integer)         security definer set search_path = '';

revoke execute on function public._pkg_lock(uuid,uuid) from public;
revoke execute on function public._pkg_write(uuid,uuid,integer,text,text,uuid,text) from public;
do $$
declare r text;
begin
  foreach r in array array['authenticated','anon','app_user'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke execute on function public._pkg_lock(uuid,uuid) from %I', r);
      execute format('revoke execute on function public._pkg_write(uuid,uuid,integer,text,text,uuid,text) from %I', r);
    end if;
  end loop;
end $$;

-- The sanctioned writers are callable by the app (RLS-equivalent gating lives
-- in the definer body via can_access_site is not needed: writes are operator
-- actions, but we still scope reads; callers are authenticated server actions).
grant execute on function public.receive_packaging(uuid,uuid,integer,text) to authenticated;
grant execute on function public.adjust_packaging(uuid,uuid,integer,text) to authenticated;
grant execute on function public.set_packaging_reorder_point(uuid,uuid,integer) to authenticated;

-- ----------------------------------------------------------------------------
-- 7. Reporting: on-hand valuation per type per site, with a low-stock flag.
-- ----------------------------------------------------------------------------
create view public.packaging_stock_report with (security_invoker = true) as
select pl.site_id,
       s.name                                   as site_name,
       pl.packaging_type_id,
       pt.name                                  as packaging_name,
       pt.kind,
       pt.is_active,
       pl.on_hand,
       pl.reorder_point,
       pt.unit_cost,
       (pl.on_hand * pt.unit_cost)              as stock_value,
       (pl.reorder_point is not null and pl.on_hand <= pl.reorder_point) as is_low,
       (pl.on_hand < 0)                         as is_negative,
       pl.updated_at
from public.packaging_levels pl
join public.sites s            on s.id = pl.site_id
join public.packaging_types pt on pt.id = pl.packaging_type_id;

comment on view public.packaging_stock_report is
  'Per-site packaging on-hand with cost valuation (on_hand * unit_cost), low-stock and negative flags. Reads scoped by the underlying packaging_levels RLS (can_access_site).';

grant select on public.packaging_stock_report to authenticated;

commit;
