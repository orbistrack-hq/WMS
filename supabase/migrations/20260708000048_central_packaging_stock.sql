-- ============================================================================
-- WMS — Migration 0047: central packaging stock (FB — packaging intake)
--
-- Packaging stock stops being per-(type, site) and becomes CENTRAL: one on-hand
-- count per packaging type, shared across every site. Packaging (boxes, labels,
-- jars, bags, Mylar) is the warehouse's own consumable pool, bought and held
-- centrally — not something each store allocates. This mirrors the central
-- parent-inventory model (FB-1 / migration 0043).
--
-- WHAT DOES *NOT* CHANGE — billing/cost attribution:
--   Consumption is still recorded per fulfillment group in `packaging_usage`
--   (one row per type per group), so the packaging cost report and per-brand
--   reimbursement are UNCHANGED. Only the physical on-hand pool becomes central;
--   the *stock decrement* now draws from that single pool instead of a site pool.
--
-- Transform-in-place:
--   * packaging_levels    collapses to PK (packaging_type_id); the site_id column
--                         (and its FK + index) is dropped. Per J's decision the
--                         central counts START AT ZERO — existing per-site rows
--                         are cleared (not summed) and re-materialize lazily on
--                         the first movement.
--   * packaging_ledger    site_id made NULLABLE — historical rows keep their
--                         site; new central movements write NULL.
--   * primitives + writers (_pkg_lock/_pkg_write, receive/adjust/set_reorder)
--                         lose the p_site argument (signatures change, so the old
--                         ones are dropped and recreated). Writes are gated to the
--                         internal ops team (admin/operator) — packaging is not a
--                         client-managed resource once it is central.
--   * consumption trigger  decrements the central pool (no site lookup).
--   * packaging_stock_report becomes per-type (no site column).
--   * RLS reads open to any signed-in user (one Supabase per client).
--
-- Also RE-SEEDS the canonical shared packaging types (fixed ids, idempotent) so
-- the types list can never come back empty on an instance where the 0046 seed
-- never landed — fixing the "packaging types not visible" report.
--
-- Reverse with rollback/20260708000047_central_packaging_stock.down.sql. The down
-- restores the per-site structure + the 0025/0039 function bodies; clearing the
-- counts is one-way, so a real rollback starts the restored pools empty.
-- ============================================================================

begin;

-- ---- 0. Drop dependents that key on the site dimension (recreated below) ----
drop view    if exists public.packaging_stock_report;
drop trigger if exists packaging_usage_stock on public.packaging_usage;
drop function if exists public.tg_packaging_usage_stock();
drop policy  if exists packaging_levels_read on public.packaging_levels;
drop policy  if exists packaging_ledger_read on public.packaging_ledger;

drop function if exists public.set_packaging_reorder_point(uuid,uuid,integer);
drop function if exists public.adjust_packaging(uuid,uuid,integer,text);
drop function if exists public.receive_packaging(uuid,uuid,integer,text);
drop function if exists public._pkg_write(uuid,uuid,integer,text,text,uuid,text);
drop function if exists public._pkg_lock(uuid,uuid);

-- ---- 1. packaging_levels: collapse per-site rows into one central pool -------
-- Start-at-zero (J): clear existing rows rather than summing. Dropping site_id
-- also drops packaging_levels_site_idx and the sites FK.
delete from public.packaging_levels;
alter table public.packaging_levels drop constraint packaging_levels_pkey;
alter table public.packaging_levels drop column site_id;
alter table public.packaging_levels add primary key (packaging_type_id);

-- ---- 2. Ledger: keep history, site becomes optional (NULL = central) --------
alter table public.packaging_ledger alter column site_id drop not null;
create index if not exists packaging_ledger_type_idx
  on public.packaging_ledger(packaging_type_id, created_at);

-- ---- 3. Central primitives (locked-row + ledger writer) ---------------------
-- Lock + fetch the level row, creating a zero row on demand.
create or replace function public._pkg_lock(p_type uuid)
returns public.packaging_levels
language plpgsql as $$
declare v public.packaging_levels;
begin
  if p_type is null then
    raise exception '_pkg_lock: packaging type is required';
  end if;
  insert into public.packaging_levels(packaging_type_id)
  values (p_type)
  on conflict (packaging_type_id) do nothing;

  select * into v from public.packaging_levels
   where packaging_type_id = p_type
   for update;
  return v;
end;
$$;

-- Apply a delta and record the matching ledger row (site NULL = central).
create or replace function public._pkg_write(
  p_type uuid, p_delta integer,
  p_reason text, p_ref_type text, p_ref_id uuid, p_note text
) returns public.packaging_levels
language plpgsql as $$
declare v public.packaging_levels;
begin
  update public.packaging_levels
     set on_hand = on_hand + p_delta, updated_at = now()
   where packaging_type_id = p_type
   returning * into v;

  insert into public.packaging_ledger(
    packaging_type_id, site_id, delta_on_hand,
    reason, reference_type, reference_id, note, actor)
  values (p_type, null, p_delta,
    p_reason, p_ref_type, p_ref_id, p_note, auth.uid());

  return v;
end;
$$;

-- ---- 4. Sanctioned writers (central; internal ops only) ---------------------
-- receive: central packaging stock arrives.
create or replace function public.receive_packaging(
  p_type uuid, p_qty integer, p_note text default null
) returns public.packaging_levels
language plpgsql security definer set search_path = '' as $$
begin
  if public.app_role() not in ('admin','operator') then
    raise exception 'receive_packaging: not authorized' using errcode = '42501';
  end if;
  if p_qty is null or p_qty <= 0 then
    raise exception 'receive_packaging: quantity must be positive (got %)', p_qty
      using errcode = 'check_violation';
  end if;
  perform public._pkg_lock(p_type);
  return public._pkg_write(p_type, p_qty, 'receipt', 'manual', null, p_note);
end;
$$;

-- adjust: signed manual correction with a required note. Blocked from making
-- on_hand negative (an operator enters a real counted figure).
create or replace function public.adjust_packaging(
  p_type uuid, p_delta integer, p_note text
) returns public.packaging_levels
language plpgsql security definer set search_path = '' as $$
declare v public.packaging_levels;
begin
  if public.app_role() not in ('admin','operator') then
    raise exception 'adjust_packaging: not authorized' using errcode = '42501';
  end if;
  if p_delta = 0 then
    raise exception 'adjust_packaging: delta must be non-zero';
  end if;
  if p_note is null or length(trim(p_note)) = 0 then
    raise exception 'adjust_packaging: a note is required';
  end if;
  v := public._pkg_lock(p_type);
  if v.on_hand + p_delta < 0 then
    raise exception 'Adjustment would make packaging on_hand negative: on_hand %, delta %',
      v.on_hand, p_delta using errcode = 'check_violation';
  end if;
  return public._pkg_write(p_type, p_delta, 'manual_adjustment', 'manual', null, p_note);
end;
$$;

-- set the central reorder point (low-stock threshold). NULL clears it.
create or replace function public.set_packaging_reorder_point(
  p_type uuid, p_point integer
) returns public.packaging_levels
language plpgsql security definer set search_path = '' as $$
declare v public.packaging_levels;
begin
  if public.app_role() not in ('admin','operator') then
    raise exception 'set_packaging_reorder_point: not authorized' using errcode = '42501';
  end if;
  if p_point is not null and p_point < 0 then
    raise exception 'set_packaging_reorder_point: reorder point cannot be negative';
  end if;
  perform public._pkg_lock(p_type);
  update public.packaging_levels
     set reorder_point = p_point, updated_at = now()
   where packaging_type_id = p_type
   returning * into v;
  return v;
end;
$$;

-- ---- 5. Consumption: decrement the central pool at packing ------------------
-- packaging_usage still records ONE row per type per fulfillment group, so a
-- combined-order group's box/label is decremented exactly once. The site no
-- longer matters for the stock decrement (central pool).
create or replace function public.tg_packaging_usage_stock()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_delta integer;
begin
  if tg_op = 'INSERT' then
    if new.quantity <> 0 then
      perform public._pkg_lock(new.packaging_type_id);
      perform public._pkg_write(new.packaging_type_id, -new.quantity,
        'consume', 'packaging_usage', new.id, null);
    end if;
    return new;

  elsif tg_op = 'UPDATE' then
    if new.packaging_type_id is distinct from old.packaging_type_id then
      perform public._pkg_lock(old.packaging_type_id);
      perform public._pkg_write(old.packaging_type_id, old.quantity,
        'consume_reversal', 'packaging_usage', new.id, 'type changed');
      perform public._pkg_lock(new.packaging_type_id);
      perform public._pkg_write(new.packaging_type_id, -new.quantity,
        'consume', 'packaging_usage', new.id, 'type changed');
    else
      v_delta := -(new.quantity - old.quantity);
      if v_delta <> 0 then
        perform public._pkg_lock(new.packaging_type_id);
        perform public._pkg_write(new.packaging_type_id, v_delta,
          'consume', 'packaging_usage', new.id, 'quantity edited');
      end if;
    end if;
    return new;

  else  -- DELETE: a packaging line was removed; give the stock back.
    if old.quantity <> 0 then
      perform public._pkg_lock(old.packaging_type_id);
      perform public._pkg_write(old.packaging_type_id, old.quantity,
        'consume_reversal', 'packaging_usage', old.id, null);
    end if;
    return old;
  end if;
end;
$$;

create trigger packaging_usage_stock
  after insert or update or delete on public.packaging_usage
  for each row execute function public.tg_packaging_usage_stock();

-- ---- 6. Seal the primitives (SECURITY DEFINER, revoked from API roles) ------
alter function public._pkg_lock(uuid)                              security definer set search_path = '';
alter function public._pkg_write(uuid,integer,text,text,uuid,text) security definer set search_path = '';

revoke execute on function public._pkg_lock(uuid)                              from public;
revoke execute on function public._pkg_write(uuid,integer,text,text,uuid,text) from public;
do $$
declare r text;
begin
  foreach r in array array['authenticated','anon','app_user'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke execute on function public._pkg_lock(uuid) from %I', r);
      execute format('revoke execute on function public._pkg_write(uuid,integer,text,text,uuid,text) from %I', r);
    end if;
  end loop;
end $$;

-- ---- 7. Grants for the writers (the app_role check is the real gate) --------
revoke execute on function public.receive_packaging(uuid,integer,text)         from public;
revoke execute on function public.adjust_packaging(uuid,integer,text)          from public;
revoke execute on function public.set_packaging_reorder_point(uuid,integer)    from public;
grant  execute on function public.receive_packaging(uuid,integer,text)         to authenticated;
grant  execute on function public.adjust_packaging(uuid,integer,text)          to authenticated;
grant  execute on function public.set_packaging_reorder_point(uuid,integer)    to authenticated;

-- ---- 8. RLS reads: open to any signed-in user (single-tenant per deployment) -
create policy packaging_levels_read on public.packaging_levels
  for select using (auth.uid() is not null);
create policy packaging_ledger_read on public.packaging_ledger
  for select using (auth.uid() is not null);

-- ---- 9. Central report view -------------------------------------------------
create view public.packaging_stock_report with (security_invoker = true) as
select pl.packaging_type_id,
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
join public.packaging_types pt on pt.id = pl.packaging_type_id;

comment on view public.packaging_stock_report is
  'Central packaging on-hand with cost valuation (on_hand * unit_cost), low-stock and negative flags. One row per packaging type (no site). Reads open to any signed-in user.';

grant select on public.packaging_stock_report to authenticated;

-- ---- 10. Re-seed the canonical shared packaging types (idempotent) ----------
-- Guarantees the standard types exist + are readable even on an instance where
-- the 0046 seed never landed (fixes the "types not visible / list empty" report).
-- Same fixed ids as 0046, so this is a no-op where they already exist.
insert into public.packaging_types (id, name, kind, unit_cost, site_id) values
  ('fb600000-0000-0000-0000-0000000000b1','Box','box',0.45,null),
  ('fb600000-0000-0000-0000-0000000000e1','Label','shipping_label',0.03,null),
  ('fb600000-0000-0000-0000-0000000000a1','3.5g Jar','jar',0.40,null),
  ('fb600000-0000-0000-0000-0000000000a2','Jar Label','jar_label',0.03,null),
  ('fb600000-0000-0000-0000-0000000000f1','Vacuum Sealed Bag','vacuum_bag',0.50,null),
  ('fb600000-0000-0000-0000-0000000000c1','Mylar Bag 4x6x2 (7g)','mylar_bag',0.12,null),
  ('fb600000-0000-0000-0000-0000000000c2','Mylar Bag 6x9x3 (14/28g)','mylar_bag',0.20,null)
on conflict (id) do nothing;

commit;
