-- ============================================================================
-- Rollback 0039: undo client-scoped packaging types + client-usable merge.
--
-- Restores the exact post-0038 state:
--   * packaging_types back to a single global list (drop site_id + scoped
--     policies; recreate the Phase-A read/admin policies).
--   * receive/adjust/set_reorder packaging stock functions back to their 0025
--     bodies (no site guard, no type/site consistency check).
--   * merge_products back to the operator-gated, losers-only-site-check 0033 body.
-- ============================================================================

begin;

-- ---- 3. merge_products: restore the 0033 (operator-gated) body -------------
create or replace function public.merge_products(
  p_survivor uuid,
  p_losers   uuid[],
  p_dry_run  boolean default false
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_losers     uuid[];
  v_conflicts  jsonb;
  v_moved      integer := 0;
  v_absorbed   uuid[];
  v_bad_site   uuid;
begin
  if not public.is_operator() then
    raise exception 'merge_products: not authorized';
  end if;
  if p_survivor is null then
    raise exception 'merge_products: survivor is required';
  end if;
  if p_losers is null or array_length(p_losers, 1) is null then
    raise exception 'merge_products: pick at least one product to merge in';
  end if;
  select array_agg(distinct l) into v_losers
    from unnest(p_losers) as l
   where l is not null and l <> p_survivor;
  if v_losers is null or array_length(v_losers, 1) is null then
    raise exception 'merge_products: nothing to merge (only the survivor was given)';
  end if;
  if (select count(*) from public.products p where p.id = p_survivor) = 0 then
    raise exception 'merge_products: survivor product not found';
  end if;
  if (select count(*) from public.products p where p.id = any(v_losers))
       <> array_length(v_losers, 1) then
    raise exception 'merge_products: one or more products to merge no longer exist';
  end if;
  select cs.site_id into v_bad_site
    from public.child_skus cs
   where cs.product_id = any(v_losers)
     and not public.can_access_site(cs.site_id)
   limit 1;
  if v_bad_site is not null then
    raise exception 'merge_products: you do not have access to every site involved';
  end if;

  with involved as (
    select cs.site_id, cs.sku, cs.grams_per_unit,
           coalesce(cs.grams_per_unit, -1) as wkey
      from public.child_skus cs
     where cs.product_id = p_survivor or cs.product_id = any(v_losers)
  ),
  clashes as (
    select site_id, wkey,
           max(grams_per_unit)                         as grams,
           count(*)                                    as n,
           array_remove(array_agg(sku order by sku), null) as skus
      from involved
     group by site_id, wkey
    having count(*) > 1
  )
  select coalesce(
           jsonb_agg(jsonb_build_object(
             'site_id',   c.site_id,
             'site_name', s.name,
             'grams',     c.grams,
             'skus',      to_jsonb(c.skus))),
           '[]'::jsonb)
    into v_conflicts
    from clashes c
    join public.sites s on s.id = c.site_id;

  if v_conflicts <> '[]'::jsonb then
    if p_dry_run then
      return jsonb_build_object(
        'ok', false, 'dry_run', true, 'survivor_id', p_survivor,
        'moved', 0, 'absorbed', '[]'::jsonb, 'conflicts', v_conflicts);
    end if;
    raise exception 'merge_products: site/weight conflicts must be resolved first (%)',
      v_conflicts using errcode = '23505';
  end if;

  if p_dry_run then
    select count(*) into v_moved
      from public.child_skus cs where cs.product_id = any(v_losers);
    return jsonb_build_object(
      'ok', true, 'dry_run', true, 'survivor_id', p_survivor,
      'moved', v_moved, 'absorbed', to_jsonb(v_losers), 'conflicts', '[]'::jsonb);
  end if;

  with moved as (
    update public.child_skus cs
       set product_id = p_survivor
     where cs.product_id = any(v_losers)
    returning 1)
  select count(*) into v_moved from moved;

  update public.products set is_active = true where id = p_survivor;

  with emptied as (
    update public.products p
       set is_active = false
     where p.id = any(v_losers)
       and not exists (
         select 1 from public.child_skus c where c.product_id = p.id)
    returning p.id)
  select coalesce(array_agg(id), '{}'::uuid[]) into v_absorbed from emptied;

  insert into public.product_merge_log
    (sku, survivor_product_id, absorbed_product_ids, kind, merged_by)
  values (null, p_survivor, v_absorbed, 'manual', auth.uid());

  return jsonb_build_object(
    'ok', true, 'dry_run', false, 'survivor_id', p_survivor,
    'moved', v_moved, 'absorbed', to_jsonb(v_absorbed), 'conflicts', '[]'::jsonb);
end;
$$;

comment on function public.merge_products(uuid, uuid[], boolean) is
  'Manual product merge: move loser products'' child SKUs onto a survivor, deactivate the emptied losers, and log it. Operators/admins only. Refuses genuine (site, weight) collisions (post-0028 weight-variant aware); p_dry_run previews without writing.';

-- ---- 2. Packaging stock writers: restore the 0025 bodies (no site guard) ----
create or replace function public.receive_packaging(
  p_type uuid, p_site uuid, p_qty integer, p_note text default null
) returns public.packaging_levels
language plpgsql security definer set search_path = '' as $$
begin
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

-- ---- 1. packaging_types: drop scoped policies + column, restore Phase-A -----
drop policy if exists packaging_types_read   on public.packaging_types;
drop policy if exists packaging_types_insert on public.packaging_types;
drop policy if exists packaging_types_update on public.packaging_types;
drop policy if exists packaging_types_delete on public.packaging_types;

create policy packaging_types_read on public.packaging_types for select
  using (auth.uid() is not null);
create policy packaging_types_admin on public.packaging_types for all
  using (public.is_admin()) with check (public.is_admin());

drop index if exists public.packaging_types_site_idx;
alter table public.packaging_types drop column if exists site_id;

commit;
