-- ============================================================================
-- WMS — Migration 0010: atomic order creation RPC
--
-- Order creation has three coupled side effects that must succeed or fail as a
-- unit: (1) a fulfillment group is opened (every order belongs to exactly one —
-- a solo order is a group of one), (2) the order + line items are written, and
-- (3) stock is reserved (standard) or removed to layby (layaway) through the
-- guarded inventory state machine. Doing this from the client as separate calls
-- is not atomic — a mid-sequence failure would orphan a group or partially
-- reserve stock. This function makes it one transaction, matching the project
-- rule that every inventory/money mutation goes through a guarded SQL function.
--
-- Returns the new order's id. Raises (rolling everything back) on any bad input.
-- ============================================================================

begin;

create or replace function public.create_order(
  p_site_id        uuid,
  p_lines          jsonb,                 -- [{child_sku_id, quantity, unit_price?, discount?, tax?}]
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
  p_notes          text    default null
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
  -- ---- validate header ----------------------------------------------------
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

  -- ---- open the fulfillment group (group of one) --------------------------
  insert into public.fulfillment_groups (site_id, customer_id)
  values (p_site_id, p_customer_id)
  returning id into v_group_id;

  -- ---- create the order ---------------------------------------------------
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

  -- keep the group's ship-to key aligned with the order (used for combine match)
  update public.fulfillment_groups g
     set ship_to_key = o.ship_to_key
    from public.orders o
   where g.id = v_group_id and o.id = v_order_id;

  -- ---- line items ---------------------------------------------------------
  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_sku_id := (v_line->>'child_sku_id')::uuid;
    v_qty    := (v_line->>'quantity')::integer;

    if v_sku_id is null then
      raise exception 'create_order: line missing child_sku_id';
    end if;
    if v_qty is null or v_qty <= 0 then
      raise exception 'create_order: line quantity must be positive (sku %)', v_sku_id;
    end if;

    -- the child SKU must exist and belong to this order's site
    select site_id, price into v_sku_site, v_sku_price
      from public.child_skus where id = v_sku_id;
    if v_sku_site is null then
      raise exception 'create_order: child SKU % not found', v_sku_id;
    end if;
    if v_sku_site <> p_site_id then
      raise exception 'create_order: child SKU % is not at site %', v_sku_id, p_site_id;
    end if;

    -- price: caller value if given, else snapshot the SKU's current price
    v_price := coalesce((v_line->>'unit_price')::numeric, v_sku_price);

    insert into public.order_line_items
      (order_id, child_sku_id, quantity, unit_price, discount, tax)
    values
      (v_order_id, v_sku_id, v_qty, v_price,
       coalesce((v_line->>'discount')::numeric, 0),
       coalesce((v_line->>'tax')::numeric, 0))
    returning id into v_line_id;
  end loop;

  -- ---- reserve (standard) / remove to layby (layaway) ---------------------
  -- Guarded path: raises and rolls the whole order back if stock is short.
  perform public.apply_order_creation(v_order_id);

  return v_order_id;
end;
$$;

comment on function public.create_order is
  'Atomically opens a fulfillment group, writes the order + line items, and reserves/lays-away stock. Returns the new order id.';

commit;
