-- Rollback 0033: restore the pre-weight (site-only) merge_products conflict rule.
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
    select cs.id, cs.site_id, cs.sku
      from public.child_skus cs
     where cs.product_id = p_survivor or cs.product_id = any(v_losers)
  ),
  clashes as (
    select i.site_id, count(*) as n,
           array_remove(array_agg(i.sku order by i.sku), null) as skus
      from involved i
     group by i.site_id
    having count(*) > 1
  )
  select coalesce(
           jsonb_agg(jsonb_build_object(
             'site_id', c.site_id,
             'site_name', s.name,
             'skus', to_jsonb(c.skus))),
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
    raise exception 'merge_products: site conflicts must be resolved first (%)',
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

commit;
