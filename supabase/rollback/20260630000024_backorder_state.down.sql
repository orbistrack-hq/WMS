-- Rollback migration 0024: restore pre-backorder function bodies and drop the
-- backorder columns/functions. Mirrors the originals from migrations 0002, 0010,
-- 0017. Run only when no order carries backordered_qty > 0 (else reserved counts
-- would be understated after revert).
begin;

-- create_order: back to the 17-arg version (drop the backorder overload first).
drop function if exists public.create_order(
  uuid,jsonb,uuid,text,text,date,timestamptz,text,text,text,text,text,text,text,numeric,numeric,text,boolean);
drop function if exists public.apply_order_creation(uuid,boolean);

create or replace function public.apply_order_creation(p_order_id uuid)
returns void language plpgsql as $$
declare r record; v_type text;
begin
  select order_type into v_type from public.orders where id = p_order_id;
  if v_type is null then raise exception 'Order % not found', p_order_id; end if;
  for r in select id, child_sku_id, quantity from public.order_line_items where order_id = p_order_id loop
    if v_type = 'layaway' then
      perform public.layaway_book(r.child_sku_id, r.quantity, 'order_line_item', r.id);
    else
      perform public.reserve_stock(r.child_sku_id, r.quantity, 'order_line_item', r.id);
    end if;
  end loop;
end;
$$;

create or replace function public.create_order(
  p_site_id uuid, p_lines jsonb, p_customer_id uuid default null,
  p_channel text default 'manual', p_order_type text default 'standard',
  p_sale_date date default current_date, p_entered_at timestamptz default now(),
  p_ship_to_name text default null, p_ship_to_address1 text default null,
  p_ship_to_address2 text default null, p_ship_to_city text default null,
  p_ship_to_region text default null, p_ship_to_postal text default null,
  p_ship_to_country text default null, p_discount_total numeric default 0,
  p_tax_total numeric default 0, p_notes text default null
) returns uuid language plpgsql as $$
declare
  v_group_id uuid; v_order_id uuid; v_line jsonb; v_sku_id uuid; v_qty integer;
  v_price numeric(12,2); v_line_id uuid; v_sku_site uuid; v_sku_price numeric(12,2);
begin
  if p_site_id is null then raise exception 'create_order: site is required'; end if;
  if p_channel not in ('manual','shopify','woocommerce') then
    raise exception 'create_order: invalid channel %', p_channel; end if;
  if p_order_type not in ('standard','layaway') then
    raise exception 'create_order: invalid order_type %', p_order_type; end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array'
     or jsonb_array_length(p_lines) = 0 then
    raise exception 'create_order: at least one line item is required'; end if;

  insert into public.fulfillment_groups (site_id, customer_id)
  values (p_site_id, p_customer_id) returning id into v_group_id;

  insert into public.orders (
    site_id, customer_id, group_id, channel, order_type, entered_at, sale_date,
    ship_to_name, ship_to_address1, ship_to_address2, ship_to_city,
    ship_to_region, ship_to_postal, ship_to_country, discount_total, tax_total, notes
  ) values (
    p_site_id, p_customer_id, v_group_id, p_channel, p_order_type,
    coalesce(p_entered_at, now()), coalesce(p_sale_date, current_date),
    p_ship_to_name, p_ship_to_address1, p_ship_to_address2, p_ship_to_city,
    p_ship_to_region, p_ship_to_postal, p_ship_to_country,
    coalesce(p_discount_total, 0), coalesce(p_tax_total, 0), p_notes
  ) returning id into v_order_id;

  update public.fulfillment_groups g set ship_to_key = o.ship_to_key
    from public.orders o where g.id = v_group_id and o.id = v_order_id;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_sku_id := (v_line->>'child_sku_id')::uuid;
    v_qty    := (v_line->>'quantity')::integer;
    if v_sku_id is null then raise exception 'create_order: line missing child_sku_id'; end if;
    if v_qty is null or v_qty <= 0 then
      raise exception 'create_order: line quantity must be positive (sku %)', v_sku_id; end if;
    select site_id, price into v_sku_site, v_sku_price from public.child_skus where id = v_sku_id;
    if v_sku_site is null then raise exception 'create_order: child SKU % not found', v_sku_id; end if;
    if v_sku_site <> p_site_id then
      raise exception 'create_order: child SKU % is not at site %', v_sku_id, p_site_id; end if;
    v_price := coalesce((v_line->>'unit_price')::numeric, v_sku_price);
    insert into public.order_line_items
      (order_id, child_sku_id, quantity, unit_price, discount, tax)
    values (v_order_id, v_sku_id, v_qty, v_price,
       coalesce((v_line->>'discount')::numeric, 0), coalesce((v_line->>'tax')::numeric, 0))
    returning id into v_line_id;
  end loop;

  perform public.apply_order_creation(v_order_id);
  return v_order_id;
end;
$$;

create or replace function public.apply_order_cancellation(p_order_id uuid)
returns void language plpgsql as $$
declare r record; v_type text;
begin
  select order_type into v_type from public.orders where id = p_order_id;
  if v_type is null then raise exception 'Order % not found', p_order_id; end if;
  for r in select id, child_sku_id, quantity from public.order_line_items where order_id = p_order_id loop
    if v_type = 'layaway' then
      perform public.layaway_cancel(r.child_sku_id, r.quantity, 'order_line_item', r.id);
    else
      perform public.release_stock(r.child_sku_id, r.quantity, 'order_line_item', r.id);
    end if;
  end loop;
end;
$$;

create or replace function public.apply_order_fulfillment(p_order_id uuid)
returns void language plpgsql as $$
declare r record; v_type text;
begin
  select order_type into v_type from public.orders where id = p_order_id;
  if v_type is null then raise exception 'Order % not found', p_order_id; end if;
  for r in select id, child_sku_id, quantity from public.order_line_items where order_id = p_order_id loop
    if v_type = 'layaway' then
      perform public.layaway_consume(r.child_sku_id, r.quantity, 'order_line_item', r.id);
    else
      perform public.consume_stock(r.child_sku_id, r.quantity, 'order_line_item', r.id);
    end if;
  end loop;
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
    raise exception 'manual adjustment requires a note'; end if;
  v := public._inv_lock(p_child_sku_id);
  if v.on_hand + p_delta < 0 then
    raise exception 'Adjustment would make on_hand negative for %: on_hand %, delta %',
      p_child_sku_id, v.on_hand, p_delta using errcode = 'check_violation'; end if;
  if v.on_hand + p_delta < v.reserved then
    raise exception 'Adjustment would drop on_hand below reserved for %: reserved %, new on_hand %',
      p_child_sku_id, v.reserved, v.on_hand + p_delta using errcode = 'check_violation'; end if;
  return public._inv_write(
    p_child_sku_id, p_delta, 0, 0, 'manual_adjustment', p_ref_type, p_ref_id, p_note);
end;
$$;

create or replace function public.set_on_hand_to(
  p_child_sku_id uuid, p_target integer,
  p_ref_type text default 'shopify', p_ref_id uuid default null, p_note text default null
) returns public.inventory_levels
language plpgsql security definer set search_path = '' as $$
declare v public.inventory_levels; v_target integer; v_delta integer;
begin
  if p_target is null then raise exception 'set_on_hand_to: target quantity is required'; end if;
  v := public._inv_lock(p_child_sku_id);
  v_target := greatest(p_target, v.reserved, 0);
  v_delta  := v_target - v.on_hand;
  if v_delta = 0 then return v; end if;
  return public._inv_write(
    p_child_sku_id, v_delta, 0, 0, 'shopify_sync', p_ref_type, p_ref_id,
    coalesce(p_note, 'Inventory synced from Shopify'));
end;
$$;

drop function if exists public.promote_backorders(uuid);
drop function if exists public.reserve_available(uuid,integer,text,uuid);

alter table public.order_line_items drop constraint if exists oli_backordered_within_qty;
alter table public.order_line_items drop column if exists backordered_qty;
alter table public.orders drop column if exists backordered;

commit;
