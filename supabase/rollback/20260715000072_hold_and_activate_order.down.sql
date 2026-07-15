-- Down: migration 0072 (hold + activate)
-- Drops activate_pending_order and the 19-arg create_order, and restores the
-- 0024 create_order (18-arg, no p_hold). NOTE: any orders still in
-- pending_payment should be activated or cancelled before rolling back, since
-- the restored create_order can no longer produce or reason about that state.

begin;

drop function if exists public.activate_pending_order(uuid);

drop function if exists public.create_order(
  uuid,jsonb,uuid,text,text,date,timestamptz,text,text,text,text,text,text,text,numeric,numeric,text,boolean,boolean);

create or replace function public.create_order(
  p_site_id        uuid,
  p_lines          jsonb,
  p_customer_id    uuid    default null,
  p_channel        text    default 'manual',
  p_order_type     text    default 'standard',
  p_sale_date      date    default current_date,
  p_entered_at     timestamptz default now(),
  p_ship_to_name     text  default null,
  p_ship_to_address1 text  default null,
  p_ship_to_address2 text  default null,
  p_ship_to_city     text  default null,
  p_ship_to_region   text  default null,
  p_ship_to_postal   text  default null,
  p_ship_to_country  text  default null,
  p_discount_total numeric default 0,
  p_tax_total      numeric default 0,
  p_notes          text    default null,
  p_allow_backorder boolean default false
) returns uuid
language plpgsql as $$
declare
  v_group_id uuid;
  v_order_id uuid;
  v_line     jsonb;
  v_sku_id   uuid;
  v_qty      integer;
  v_price    numeric(12,2);
  v_line_id  uuid;
  v_sku_site uuid;
  v_sku_price numeric(12,2);
begin
  if p_site_id is null then
    raise exception 'create_order: site is required';
  end if;
  if p_channel not in ('manual','shopify','woocommerce') then
    raise exception 'create_order: invalid channel %', p_channel;
  end if;
  if p_order_type not in ('standard','layaway') then
    raise exception 'create_order: invalid order_type %', p_order_type;
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array'
     or jsonb_array_length(p_lines) = 0 then
    raise exception 'create_order: at least one line item is required';
  end if;

  insert into public.fulfillment_groups (site_id, customer_id)
  values (p_site_id, p_customer_id)
  returning id into v_group_id;

  insert into public.orders (
    site_id, customer_id, group_id, channel, order_type,
    entered_at, sale_date,
    ship_to_name, ship_to_address1, ship_to_address2, ship_to_city,
    ship_to_region, ship_to_postal, ship_to_country,
    discount_total, tax_total, notes
  ) values (
    p_site_id, p_customer_id, v_group_id, p_channel, p_order_type,
    coalesce(p_entered_at, now()), coalesce(p_sale_date, current_date),
    p_ship_to_name, p_ship_to_address1, p_ship_to_address2, p_ship_to_city,
    p_ship_to_region, p_ship_to_postal, p_ship_to_country,
    coalesce(p_discount_total, 0), coalesce(p_tax_total, 0), p_notes
  ) returning id into v_order_id;

  update public.fulfillment_groups g
     set ship_to_key = o.ship_to_key
    from public.orders o
   where g.id = v_group_id and o.id = v_order_id;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_sku_id := (v_line->>'child_sku_id')::uuid;
    v_qty    := (v_line->>'quantity')::integer;

    if v_sku_id is null then
      raise exception 'create_order: line missing child_sku_id';
    end if;
    if v_qty is null or v_qty <= 0 then
      raise exception 'create_order: line quantity must be positive (sku %)', v_sku_id;
    end if;

    select site_id, price into v_sku_site, v_sku_price
      from public.child_skus where id = v_sku_id;
    if v_sku_site is null then
      raise exception 'create_order: child SKU % not found', v_sku_id;
    end if;
    if v_sku_site <> p_site_id then
      raise exception 'create_order: child SKU % is not at site %', v_sku_id, p_site_id;
    end if;

    v_price := coalesce((v_line->>'unit_price')::numeric, v_sku_price);

    insert into public.order_line_items
      (order_id, child_sku_id, quantity, unit_price, discount, tax)
    values
      (v_order_id, v_sku_id, v_qty, v_price,
       coalesce((v_line->>'discount')::numeric, 0),
       coalesce((v_line->>'tax')::numeric, 0))
    returning id into v_line_id;
  end loop;

  perform public.apply_order_creation(v_order_id, p_allow_backorder);

  return v_order_id;
end;
$$;

grant execute on function public.create_order(
  uuid,jsonb,uuid,text,text,date,timestamptz,text,text,text,text,text,text,text,numeric,numeric,text,boolean) to authenticated;

commit;
