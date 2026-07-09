-- ============================================================================
-- Rollback 0047: restore the per-(type, site) packaging pool.
--
-- Reinstates the post-0039 structure and function bodies:
--   * packaging_levels regains site_id + the composite PK + site index;
--   * packaging_ledger.site_id back to NOT NULL; the central-only index drops;
--   * primitives/writers/trigger/view/policies revert to their site-scoped forms
--     (_pkg_lock/_pkg_write from 0025; receive/adjust/set_reorder from 0039).
-- Clearing the counts in 0047 is one-way, so on real data the restored per-site
-- pools start empty and would need their site split re-entered. The re-seeded
-- canonical types are 0046's own rows (same ids) and are cleaned up by 0046.down.
-- ============================================================================

begin;

-- ---- drop the central objects ----------------------------------------------
drop view    if exists public.packaging_stock_report;
drop trigger if exists packaging_usage_stock on public.packaging_usage;
drop function if exists public.tg_packaging_usage_stock();
drop policy  if exists packaging_levels_read on public.packaging_levels;
drop policy  if exists packaging_ledger_read on public.packaging_ledger;

drop function if exists public.set_packaging_reorder_point(uuid,integer);
drop function if exists public.adjust_packaging(uuid,integer,text);
drop function if exists public.receive_packaging(uuid,integer,text);
drop function if exists public._pkg_write(uuid,integer,text,text,uuid,text);
drop function if exists public._pkg_lock(uuid);

drop index if exists public.packaging_ledger_type_idx;

-- ---- restore the site dimension on packaging_levels ------------------------
delete from public.packaging_levels;
alter table public.packaging_levels drop constraint packaging_levels_pkey;
alter table public.packaging_levels add column site_id uuid;
alter table public.packaging_levels
  add constraint packaging_levels_site_id_fkey
  foreign key (site_id) references public.sites(id) on delete cascade;
alter table public.packaging_levels alter column site_id set not null;
alter table public.packaging_levels add primary key (packaging_type_id, site_id);
create index if not exists packaging_levels_site_idx on public.packaging_levels(site_id);

alter table public.packaging_ledger alter column site_id set not null;

-- ---- restore the 0025 primitives (per-site) --------------------------------
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

-- ---- restore the 0039 site-guarded writers ---------------------------------
create or replace function public.receive_packaging(
  p_type uuid, p_site uuid, p_qty integer, p_note text default null
) returns public.packaging_levels
language plpgsql security definer set search_path = '' as $$
begin
  if not public.can_access_site(p_site) then
    raise exception 'receive_packaging: not authorized for this site'
      using errcode = '42501';
  end if;
  if exists (select 1 from public.packaging_types t
              where t.id = p_type and t.site_id is not null and t.site_id <> p_site) then
    raise exception 'receive_packaging: this packaging type belongs to another site'
      using errcode = 'check_violation';
  end if;
  if p_qty is null or p_qty <= 0 then
    raise exception 'receive_packaging: quantity must be positive (got %)', p_qty
      using errcode = 'check_violation';
  end if;
  perform public._pkg_lock(p_type, p_site);
  return public._pkg_write(p_type, p_site, p_qty, 'receipt', 'manual', null, p_note);
end;
$$;

create or replace function public.adjust_packaging(
  p_type uuid, p_site uuid, p_delta integer, p_note text
) returns public.packaging_levels
language plpgsql security definer set search_path = '' as $$
declare v public.packaging_levels;
begin
  if not public.can_access_site(p_site) then
    raise exception 'adjust_packaging: not authorized for this site'
      using errcode = '42501';
  end if;
  if exists (select 1 from public.packaging_types t
              where t.id = p_type and t.site_id is not null and t.site_id <> p_site) then
    raise exception 'adjust_packaging: this packaging type belongs to another site'
      using errcode = 'check_violation';
  end if;
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

create or replace function public.set_packaging_reorder_point(
  p_type uuid, p_site uuid, p_point integer
) returns public.packaging_levels
language plpgsql security definer set search_path = '' as $$
declare v public.packaging_levels;
begin
  if not public.can_access_site(p_site) then
    raise exception 'set_packaging_reorder_point: not authorized for this site'
      using errcode = '42501';
  end if;
  if exists (select 1 from public.packaging_types t
              where t.id = p_type and t.site_id is not null and t.site_id <> p_site) then
    raise exception 'set_packaging_reorder_point: this packaging type belongs to another site'
      using errcode = 'check_violation';
  end if;
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

-- ---- restore the 0025 consumption trigger (per-site) -----------------------
create or replace function public.tg_packaging_usage_stock()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_site  uuid;
  v_type  uuid;
  v_delta integer;
begin
  if tg_op = 'INSERT' then
    v_type  := new.packaging_type_id;
    v_delta := -new.quantity;
    select g.site_id into v_site from public.fulfillment_groups g where g.id = new.group_id;
    if v_site is not null and v_delta <> 0 then
      perform public._pkg_lock(v_type, v_site);
      perform public._pkg_write(v_type, v_site, v_delta, 'consume', 'packaging_usage', new.id, null);
    end if;
    return new;

  elsif tg_op = 'UPDATE' then
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

  else  -- DELETE
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

-- ---- re-seal primitives + restore grants -----------------------------------
alter function public._pkg_lock(uuid,uuid)                              security definer set search_path = '';
alter function public._pkg_write(uuid,uuid,integer,text,text,uuid,text) security definer set search_path = '';

revoke execute on function public._pkg_lock(uuid,uuid)                              from public;
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

revoke execute on function public.receive_packaging(uuid,uuid,integer,text)      from public;
revoke execute on function public.adjust_packaging(uuid,uuid,integer,text)       from public;
revoke execute on function public.set_packaging_reorder_point(uuid,uuid,integer) from public;
grant  execute on function public.receive_packaging(uuid,uuid,integer,text)      to authenticated;
grant  execute on function public.adjust_packaging(uuid,uuid,integer,text)       to authenticated;
grant  execute on function public.set_packaging_reorder_point(uuid,uuid,integer) to authenticated;

-- ---- restore per-site RLS reads + report view ------------------------------
create policy packaging_levels_read on public.packaging_levels
  for select using (public.can_access_site(site_id));
create policy packaging_ledger_read on public.packaging_ledger
  for select using (public.can_access_site(site_id));

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

grant select on public.packaging_stock_report to authenticated;

commit;
