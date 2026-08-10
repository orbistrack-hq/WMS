-- Down: migration 0081. Restore the 0079 four-arg adopt_bogo_sku (no force) and
-- the 0080 auto_adopt_bogo (reserved/layby skip, no force).
begin;

drop function if exists public.adopt_bogo_sku(uuid, uuid, text, integer, boolean);

create or replace function public.adopt_bogo_sku(
  p_bogo uuid, p_paid uuid,
  p_stock_mode text default 'discard',
  p_counted integer default null
) returns public.child_skus
language plpgsql security definer set search_path = '' as $$
declare b public.child_skus; p public.child_skus;
        il public.inventory_levels; pil public.inventory_levels;
        v_label text; v_move integer; v_delta integer;
begin
  if auth.uid() is not null and not public.is_operator() then
    raise exception 'adopt_bogo_sku: admin/manager only';
  end if;
  if p_stock_mode not in ('discard','move','set') then
    raise exception 'adopt_bogo_sku: invalid stock mode %', p_stock_mode;
  end if;

  select * into b from public.child_skus where id = p_bogo for update;
  if not found then raise exception 'adopt_bogo_sku: BOGO SKU % not found', p_bogo; end if;
  select * into p from public.child_skus where id = p_paid for update;
  if not found then raise exception 'adopt_bogo_sku: paid SKU % not found', p_paid; end if;

  if b.delegates_to_child_sku_id = p_paid then return b; end if;
  if b.id = p.id then raise exception 'adopt_bogo_sku: a SKU cannot adopt itself'; end if;
  if b.delegates_to_child_sku_id is not null then
    raise exception 'adopt_bogo_sku: % is already a delegate', p_bogo; end if;
  if p.delegates_to_child_sku_id is not null then
    raise exception 'adopt_bogo_sku: paid target % is itself a delegate', p_paid; end if;
  if p.site_id <> b.site_id then
    raise exception 'adopt_bogo_sku: SKUs are at different sites'; end if;
  if coalesce(p.price,0) <= 0 then
    raise exception 'adopt_bogo_sku: paid target % must have a positive price', p_paid; end if;

  select * into il from public.inventory_levels where child_sku_id = b.id for update;
  if coalesce(il.reserved,0) > 0 or coalesce(il.layby,0) > 0 then
    raise exception 'adopt_bogo_sku: % has reserved/layby stock — clear its open orders first', p_bogo;
  end if;

  if p_stock_mode = 'discard' then
    if coalesce(il.on_hand,0) <> 0 then
      perform public.adjust_stock(b.id, -il.on_hand,
        'BOGO merge: same jars, discard duplicate count (migration 0079)');
    end if;
  elsif p_stock_mode = 'move' then
    v_move := coalesce(il.on_hand,0);
    if v_move > 0 then
      perform public.adjust_stock(b.id, -v_move, 'BOGO merge: move separate pile → paid');
      perform public.adjust_stock(p.id,  v_move, 'BOGO merge: separate pile ← ' || coalesce(b.sku,'(no sku)'));
    end if;
  else
    if p_counted is null then
      raise exception 'adopt_bogo_sku: stock mode ''set'' requires a counted quantity';
    end if;
    if coalesce(il.on_hand,0) <> 0 then
      perform public.adjust_stock(b.id, -il.on_hand,
        'BOGO merge: discard duplicate count (reconciled to physical)');
    end if;
    select * into pil from public.inventory_levels where child_sku_id = p.id for update;
    v_delta := p_counted - coalesce(pil.on_hand,0);
    if v_delta <> 0 then
      perform public.adjust_stock(p.id, v_delta,
        'BOGO merge: reconcile paid to counted ' || p_counted);
    end if;
  end if;

  v_label := coalesce(p.sku,'') || '-BOGO';
  if p.sku is null
     or exists (select 1 from public.child_skus o
                 where o.site_id = b.site_id and o.sku = v_label and o.id <> b.id) then
    v_label := b.sku;
  end if;

  update public.child_skus
     set product_id                = p.product_id,
         sku                       = v_label,
         price                     = 0,
         cost                      = p.cost,
         delegates_to_child_sku_id = p.id
   where id = b.id
   returning * into b;

  update public.child_skus
     set suspected_duplicate = public._is_suspected_duplicate(
           p.id, p.site_id, p.sku, p.price, p.cost, p.track_inventory)
   where id = p.id;

  return b;
end;
$$;

grant execute on function public.adopt_bogo_sku(uuid, uuid, text, integer) to authenticated;

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
       and not cs.bogo_merge_opt_out
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

commit;
