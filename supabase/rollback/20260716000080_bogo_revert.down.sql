-- Down: migration 0080. Remove revert + opt-out; restore 0078 auto_adopt and
-- 0077 flag trigger (delegate short-circuit only).
begin;

drop function if exists public.revert_bogo_sku(uuid, integer, text, boolean);

create or replace function public.flag_suspected_duplicate()
returns trigger language plpgsql
security definer set search_path = '' as $$
begin
  if new.delegates_to_child_sku_id is not null then
    new.suspected_duplicate := false;
    return new;
  end if;
  new.suspected_duplicate := public._is_suspected_duplicate(
    new.id, new.site_id, new.sku, new.price, new.cost, new.track_inventory);
  return new;
end;
$$;

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
     where cs.delegates_to_child_sku_id is null
       and coalesce(cs.track_inventory, true)
       and coalesce(il.reserved,0) = 0
       and coalesce(il.layby,0) = 0
       and public._sku_base(cs.sku) <> ''
       and (
         public._sku_norm(cs.sku) ~ 'BOGO$'
         or (cs.suspected_duplicate and coalesce(cs.price,0) = 0 and coalesce(cs.cost,0) > 0)
       )
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

alter table public.child_skus drop column if exists bogo_merge_opt_out;

commit;
