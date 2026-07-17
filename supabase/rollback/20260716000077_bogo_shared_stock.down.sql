-- Down: migration 0077 (BOGO shared stock). Restores the pre-0077,
-- delegation-free bodies of every recreated inventory function, then drops the
-- delegation column and its helpers. SECURITY DEFINER + pinned search_path are
-- re-declared so the inventory door stays locked.
begin;

-- ---- flag trigger: drop the delegate short-circuit (0076 body) --------------
create or replace function public.flag_suspected_duplicate()
returns trigger language plpgsql
security definer set search_path = '' as $$
begin
  new.suspected_duplicate := public._is_suspected_duplicate(
    new.id, new.site_id, new.sku, new.price, new.cost, new.track_inventory);
  return new;
end;
$$;

-- ---- order stock primitives: remove the _stock_sku resolve -------------------
create or replace function public.reserve_stock(
  p_child_sku_id uuid, p_qty integer,
  p_ref_type text default 'order_line_item', p_ref_id uuid default null
) returns public.inventory_levels
language plpgsql security definer set search_path = '' as $$
declare v public.inventory_levels;
begin
  if p_qty <= 0 then raise exception 'reserve qty must be positive (got %)', p_qty; end if;
  v := public._inv_lock(p_child_sku_id);
  if v.on_hand - v.reserved < p_qty then
    raise exception 'Insufficient available stock for %: available %, requested %',
      p_child_sku_id, v.on_hand - v.reserved, p_qty using errcode = 'check_violation';
  end if;
  return public._inv_write(p_child_sku_id, 0, p_qty, 0, 'order_reserve', p_ref_type, p_ref_id, null);
end;
$$;

create or replace function public.release_stock(
  p_child_sku_id uuid, p_qty integer,
  p_ref_type text default 'order_line_item', p_ref_id uuid default null
) returns public.inventory_levels
language plpgsql security definer set search_path = '' as $$
declare v public.inventory_levels;
begin
  if p_qty <= 0 then raise exception 'release qty must be positive (got %)', p_qty; end if;
  v := public._inv_lock(p_child_sku_id);
  if v.reserved < p_qty then
    raise exception 'Cannot release more than reserved for %: reserved %, requested %',
      p_child_sku_id, v.reserved, p_qty using errcode = 'check_violation';
  end if;
  return public._inv_write(p_child_sku_id, 0, -p_qty, 0, 'order_release', p_ref_type, p_ref_id, null);
end;
$$;

create or replace function public.consume_stock(
  p_child_sku_id uuid, p_qty integer,
  p_ref_type text default 'order_line_item', p_ref_id uuid default null
) returns public.inventory_levels
language plpgsql security definer set search_path = '' as $$
declare v public.inventory_levels;
begin
  if p_qty <= 0 then raise exception 'consume qty must be positive (got %)', p_qty; end if;
  v := public._inv_lock(p_child_sku_id);
  if v.reserved < p_qty then
    raise exception 'Cannot consume more than reserved for %: reserved %, requested %',
      p_child_sku_id, v.reserved, p_qty using errcode = 'check_violation';
  end if;
  return public._inv_write(p_child_sku_id, -p_qty, -p_qty, 0, 'order_consume', p_ref_type, p_ref_id, null);
end;
$$;

create or replace function public.reserve_available(
  p_child_sku_id uuid, p_qty integer,
  p_ref_type text default 'order_line_item', p_ref_id uuid default null
) returns integer
language plpgsql security definer set search_path = '' as $$
declare v public.inventory_levels; v_take integer;
begin
  if p_qty <= 0 then return 0; end if;
  v := public._inv_lock(p_child_sku_id);
  v_take := least(greatest(v.on_hand - v.reserved, 0), p_qty);
  if v_take > 0 then
    perform public._inv_write(
      p_child_sku_id, 0, v_take, 0, 'order_reserve', p_ref_type, p_ref_id, null);
  end if;
  return v_take;
end;
$$;

create or replace function public.layaway_book(
  p_child_sku_id uuid, p_qty integer,
  p_ref_type text default 'order_line_item', p_ref_id uuid default null
) returns public.inventory_levels
language plpgsql security definer set search_path = '' as $$
declare v public.inventory_levels;
begin
  if p_qty <= 0 then raise exception 'layaway qty must be positive (got %)', p_qty; end if;
  v := public._inv_lock(p_child_sku_id);
  if v.on_hand - v.reserved < p_qty then
    raise exception 'Insufficient available stock to lay by for %: available %, requested %',
      p_child_sku_id, v.on_hand - v.reserved, p_qty using errcode = 'check_violation';
  end if;
  return public._inv_write(p_child_sku_id, -p_qty, 0, p_qty, 'layaway_remove', p_ref_type, p_ref_id, null);
end;
$$;

create or replace function public.layaway_cancel(
  p_child_sku_id uuid, p_qty integer,
  p_ref_type text default 'order_line_item', p_ref_id uuid default null
) returns public.inventory_levels
language plpgsql security definer set search_path = '' as $$
declare v public.inventory_levels;
begin
  if p_qty <= 0 then raise exception 'layaway cancel qty must be positive (got %)', p_qty; end if;
  v := public._inv_lock(p_child_sku_id);
  if v.layby < p_qty then
    raise exception 'Cannot cancel more layby than held for %: layby %, requested %',
      p_child_sku_id, v.layby, p_qty using errcode = 'check_violation';
  end if;
  return public._inv_write(p_child_sku_id, p_qty, 0, -p_qty, 'layaway_cancel', p_ref_type, p_ref_id, null);
end;
$$;

create or replace function public.layaway_consume(
  p_child_sku_id uuid, p_qty integer,
  p_ref_type text default 'order_line_item', p_ref_id uuid default null
) returns public.inventory_levels
language plpgsql security definer set search_path = '' as $$
declare v public.inventory_levels;
begin
  if p_qty <= 0 then raise exception 'layaway consume qty must be positive (got %)', p_qty; end if;
  v := public._inv_lock(p_child_sku_id);
  if v.layby < p_qty then
    raise exception 'Cannot consume more layby than held for %: layby %, requested %',
      p_child_sku_id, v.layby, p_qty using errcode = 'check_violation';
  end if;
  return public._inv_write(p_child_sku_id, 0, 0, -p_qty, 'layaway_consume', p_ref_type, p_ref_id, null);
end;
$$;

-- ---- add-stock paths: drop the delegate block -------------------------------
create or replace function public.receive_stock(
  p_child_sku_id uuid, p_qty integer,
  p_ref_type text default 'receipt', p_ref_id uuid default null, p_note text default null
) returns public.inventory_levels
language plpgsql security definer set search_path = '' as $$
declare v public.inventory_levels;
begin
  if p_qty <= 0 then raise exception 'receive qty must be positive (got %)', p_qty; end if;
  perform public._inv_lock(p_child_sku_id);
  v := public._inv_write(
    p_child_sku_id, p_qty, 0, 0, 'receipt', p_ref_type, p_ref_id, p_note);
  perform public.promote_backorders(p_child_sku_id);
  return public._inv_lock(p_child_sku_id);
end;
$$;

create or replace function public.adjust_stock(
  p_child_sku_id uuid, p_delta integer, p_note text,
  p_ref_type text default 'manual', p_ref_id uuid default null
) returns public.inventory_levels
language plpgsql security definer set search_path = '' as $$
declare v public.inventory_levels;
begin
  if p_delta = 0 then raise exception 'adjustment delta must be non-zero'; end if;
  if p_note is null or length(trim(p_note)) = 0 then
    raise exception 'manual adjustment requires a note';
  end if;
  v := public._inv_lock(p_child_sku_id);
  if v.on_hand + p_delta < 0 then
    raise exception 'Adjustment would make on_hand negative for %: on_hand %, delta %',
      p_child_sku_id, v.on_hand, p_delta using errcode = 'check_violation';
  end if;
  if v.on_hand + p_delta < v.reserved then
    raise exception 'Adjustment would drop on_hand below reserved for %: reserved %, new on_hand %',
      p_child_sku_id, v.reserved, v.on_hand + p_delta using errcode = 'check_violation';
  end if;
  v := public._inv_write(
    p_child_sku_id, p_delta, 0, 0, 'manual_adjustment', p_ref_type, p_ref_id, p_note);
  if p_delta > 0 then
    perform public.promote_backorders(p_child_sku_id);
    v := public._inv_lock(p_child_sku_id);
  end if;
  return v;
end;
$$;

create or replace function public.set_on_hand_to(
  p_child_sku_id uuid, p_target integer,
  p_ref_type text default 'shopify', p_ref_id uuid default null, p_note text default null
) returns public.inventory_levels
language plpgsql security definer set search_path = '' as $$
declare v public.inventory_levels; v_target integer; v_delta integer;
begin
  if p_target is null then
    raise exception 'set_on_hand_to: target quantity is required';
  end if;
  v := public._inv_lock(p_child_sku_id);
  v_target := greatest(p_target, v.reserved, 0);
  v_delta  := v_target - v.on_hand;
  if v_delta = 0 then return v; end if;
  v := public._inv_write(
    p_child_sku_id, v_delta, 0, 0, 'shopify_sync', p_ref_type, p_ref_id,
    coalesce(p_note, 'Inventory synced from Shopify'));
  if v_delta > 0 then
    perform public.promote_backorders(p_child_sku_id);
    v := public._inv_lock(p_child_sku_id);
  end if;
  return v;
end;
$$;

-- ---- promote_backorders: restore the direct child_sku_id match ---------------
create or replace function public.promote_backorders(p_child_sku_id uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare r record; v_take integer; v_total integer := 0;
begin
  for r in
    select oli.id, oli.backordered_qty
      from public.order_line_items oli
      join public.orders o on o.id = oli.order_id
     where oli.child_sku_id = p_child_sku_id
       and oli.backordered_qty > 0
       and o.order_type = 'standard'
       and o.status not in ('fulfilled','cancelled')
     order by o.entered_at asc, o.id asc, oli.id asc
  loop
    v_take := public.reserve_available(
      p_child_sku_id, r.backordered_qty, 'order_line_item', r.id);
    exit when v_take = 0;
    update public.order_line_items
       set backordered_qty = backordered_qty - v_take
     where id = r.id;
    v_total := v_total + v_take;
  end loop;

  update public.orders o
     set backordered = exists (
       select 1 from public.order_line_items x
        where x.order_id = o.id and x.backordered_qty > 0)
   where o.status not in ('fulfilled','cancelled')
     and exists (
       select 1 from public.order_line_items y
        where y.order_id = o.id and y.child_sku_id = p_child_sku_id);

  return v_total;
end;
$$;

-- ---- drop the delegation surface --------------------------------------------
drop view if exists public.bogo_review_queue;
drop function if exists public.auto_adopt_bogo();
drop function if exists public.adopt_bogo_sku(uuid, uuid);
drop function if exists public._sku_base(text);

drop trigger if exists t_childskus_validate_delegate on public.child_skus;
drop function if exists public.validate_sku_delegate();

drop function if exists public._stock_sku(uuid);

drop index if exists public.child_skus_delegates_to_idx;
alter table public.child_skus drop column if exists delegates_to_child_sku_id;

commit;
