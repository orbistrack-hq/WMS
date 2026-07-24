-- Down: migration 0078. Restore the pre-suffix detection (0076) and the
-- price-0-only auto_adopt_bogo (0077).
begin;

create or replace function public._is_suspected_duplicate(
  p_id uuid, p_site_id uuid, p_sku text, p_price numeric, p_cost numeric,
  p_track_inventory boolean
) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare v_norm text := public._sku_norm(p_sku);
begin
  if coalesce(p_track_inventory, true)
     and coalesce(p_price, 0) = 0
     and coalesce(p_cost, 0) > 0 then
    return true;
  end if;
  if v_norm <> '' and exists (
    select 1 from public.child_skus o
     where o.site_id = p_site_id
       and o.id <> p_id
       and o.sku is not null and o.sku <> ''
       and public._sku_norm(o.sku) = v_norm
  ) then
    return true;
  end if;
  return false;
end;
$$;

update public.child_skus cs
   set suspected_duplicate = public._is_suspected_duplicate(
         cs.id, cs.site_id, cs.sku, cs.price, cs.cost, cs.track_inventory)
 where cs.delegates_to_child_sku_id is null;

create or replace function public.auto_adopt_bogo()
returns integer language plpgsql security definer set search_path = '' as $$
declare b record; v_ids uuid[]; v_n integer := 0;
begin
  if auth.uid() is not null and not public.is_operator() then
    raise exception 'auto_adopt_bogo: admin/manager only';
  end if;

  for b in
    select cs.id, cs.site_id, cs.cost, public._sku_base(cs.sku) as base
      from public.child_skus cs
      join public.inventory_levels il on il.child_sku_id = cs.id
     where cs.suspected_duplicate
       and cs.delegates_to_child_sku_id is null
       and coalesce(cs.track_inventory, true)
       and coalesce(cs.price,0) = 0
       and coalesce(cs.cost,0) > 0
       and coalesce(il.reserved,0) = 0
       and coalesce(il.layby,0) = 0
       and public._sku_base(cs.sku) <> ''
  loop
    select array_agg(o.id) into v_ids
      from public.child_skus o
     where o.site_id = b.site_id
       and o.id <> b.id
       and o.is_active
       and o.delegates_to_child_sku_id is null
       and coalesce(o.price,0) > 0
       and o.cost = b.cost
       and public._sku_norm(o.sku) = b.base;

    if array_length(v_ids, 1) = 1 then
      perform public.adopt_bogo_sku(b.id, v_ids[1]);
      v_n := v_n + 1;
    end if;
  end loop;

  return v_n;
end;
$$;

commit;
