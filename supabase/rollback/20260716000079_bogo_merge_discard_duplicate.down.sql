-- Down: migration 0079. Restore the 0077 two-arg adopt_bogo_sku (move/sum).
begin;

drop function if exists public.adopt_bogo_sku(uuid, uuid, text, integer);

create or replace function public.adopt_bogo_sku(p_bogo uuid, p_paid uuid)
returns public.child_skus
language plpgsql security definer set search_path = '' as $$
declare b public.child_skus; p public.child_skus; il public.inventory_levels;
        v_label text; v_move integer;
begin
  if auth.uid() is not null and not public.is_operator() then
    raise exception 'adopt_bogo_sku: admin/manager only';
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

  v_move := coalesce(il.on_hand,0);
  if v_move > 0 then
    perform public.adjust_stock(b.id,  -v_move, 'BOGO consolidation → paid (migration 0077)');
    perform public.adjust_stock(p.id,   v_move, 'BOGO consolidation ← ' || coalesce(b.sku,'(no sku)'));
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

grant execute on function public.adopt_bogo_sku(uuid, uuid) to authenticated;

commit;
