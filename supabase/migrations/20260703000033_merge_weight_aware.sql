-- ============================================================================
-- WMS — Migration 0033: make merge_products weight-variant aware
--
-- merge_products (0022) predates weight variants. Migration 0028 changed the
-- child uniqueness rule from (product, site) to (product, site, weight), so a
-- parent now legitimately holds many children at one site — one per weight.
--
-- But merge_products' conflict check still groups by SITE ALONE and flags any
-- site held by >1 child as a clash. That means a parent's OWN four weight
-- children (3.5/7/14/28g) at one site register as a "conflict", so merging two
-- weight-variant catalogs is refused even when their (site, weight) cells don't
-- actually overlap. That is the "resolve these site conflicts first" wall.
--
-- Fix: key the conflict on (site, weight) — matching the real unique index
-- child_skus_product_site_variant_key (product_id, site_id, coalesce(grams,-1)).
-- A conflict is now only a genuine duplicate (site, weight) cell across the
-- survivor + losers. Disjoint weight/site catalogs merge cleanly; a true
-- same-site same-weight collision still stops (now reporting the weight too),
-- to be resolved deliberately (collision auto-resolution is a later change).
--
-- Signature is unchanged, so existing grants and callers are untouched.
-- Reverse with the matching down migration.
-- ============================================================================

begin;

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
  -- ---- authorization ------------------------------------------------------
  if not public.is_operator() then
    raise exception 'merge_products: not authorized';
  end if;

  -- ---- validate inputs ----------------------------------------------------
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

  -- ---- site-access check: caller must own every site being moved ----------
  select cs.site_id into v_bad_site
    from public.child_skus cs
   where cs.product_id = any(v_losers)
     and not public.can_access_site(cs.site_id)
   limit 1;
  if v_bad_site is not null then
    raise exception 'merge_products: you do not have access to every site involved';
  end if;

  -- ---- conflict detection (one child per product per site PER WEIGHT) -----
  -- A real conflict is a duplicate (site, weight) cell across survivor+losers.
  -- coalesce(grams,-1) folds the non-weight child to a single sentinel, exactly
  -- as child_skus_product_site_variant_key does. Grouping by site alone (the old
  -- rule) wrongly counted a parent's own distinct weights as clashes.
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

  -- ---- stop here if there's a genuine (site, weight) collision -------------
  if v_conflicts <> '[]'::jsonb then
    if p_dry_run then
      return jsonb_build_object(
        'ok', false, 'dry_run', true, 'survivor_id', p_survivor,
        'moved', 0, 'absorbed', '[]'::jsonb, 'conflicts', v_conflicts);
    end if;
    raise exception 'merge_products: site/weight conflicts must be resolved first (%)',
      v_conflicts using errcode = '23505';
  end if;

  -- ---- dry run: report what WOULD happen, change nothing ------------------
  if p_dry_run then
    select count(*) into v_moved
      from public.child_skus cs where cs.product_id = any(v_losers);
    return jsonb_build_object(
      'ok', true, 'dry_run', true, 'survivor_id', p_survivor,
      'moved', v_moved, 'absorbed', to_jsonb(v_losers), 'conflicts', '[]'::jsonb);
  end if;

  -- ---- commit -------------------------------------------------------------
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

commit;
