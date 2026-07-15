-- ============================================================================
-- WMS — Migration 0072: hold an unpaid order, activate it on payment
--
-- Builds on 0071 (the pending_payment status). Two changes:
--
--   1. create_order gains p_hold. When true, the order + line items are written
--      as `pending_payment` and NOTHING is reserved — the store sale isn't paid
--      yet, so we don't set aside stock or surface it as work. Default false, so
--      every existing caller (manual entry, paid store imports) is unchanged.
--
--   2. activate_pending_order(p_order_id) runs when the store confirms payment
--      (Woo pending->processing, Shopify orders/paid). It reserves stock now —
--      backordering any shortfall, since the sale already happened upstream —
--      and promotes pending_payment -> created so the order enters the normal
--      pick/pack flow. Idempotent: a re-delivered paid webhook after activation
--      is a harmless no-op.
--
-- A denied/failed/cancelled payment still goes through cancel_order, which 0071
-- taught to release nothing for a never-reserved held order.
--
-- Signature note: adding p_hold makes a NEW create_order signature. We drop the
-- prior 18-arg version first so the default arg can't create an ambiguous
-- overload (same guard the 0024 migration used).
-- ============================================================================

begin;

drop function if exists public.create_order(
  uuid,jsonb,uuid,text,text,date,timestamptz,text,text,text,text,text,text,text,numeric,numeric,text,boolean);

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
  p_allow_backorder boolean default false,
  p_hold           boolean default false
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
  if p_hold and p_order_type <> 'standard' then
    raise exception 'create_order: only standard orders can be held (got %)', p_order_type;
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array'
     or jsonb_array_length(p_lines) = 0 then
    raise exception 'create_order: at least one line item is required';
  end if;

  insert into public.fulfillment_groups (site_id, customer_id)
  values (p_site_id, p_customer_id)
  returning id into v_group_id;

  insert into public.orders (
    site_id, customer_id, group_id, channel, order_type, status,
    entered_at, sale_date,
    ship_to_name, ship_to_address1, ship_to_address2, ship_to_city,
    ship_to_region, ship_to_postal, ship_to_country,
    discount_total, tax_total, notes
  ) values (
    p_site_id, p_customer_id, v_group_id, p_channel, p_order_type,
    case when p_hold then 'pending_payment' else 'created' end,
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

  -- Paid/manual orders reserve now; held orders reserve nothing until payment
  -- clears and activate_pending_order() runs.
  if not p_hold then
    perform public.apply_order_creation(v_order_id, p_allow_backorder);
  end if;

  return v_order_id;
end;
$$;

comment on function public.create_order is
  'Atomically opens a fulfillment group, writes the order + line items, and reserves/lays-away stock. With p_allow_backorder, short lines are backordered instead of failing. With p_hold, the order is written as pending_payment and reserves NOTHING until activate_pending_order() runs at payment confirmation. Returns the new order id.';

-- ---------------------------------------------------------------------------
-- activate_pending_order — payment cleared: reserve stock and enter pick/pack.
-- ---------------------------------------------------------------------------
create or replace function public.activate_pending_order(p_order_id uuid)
returns public.orders language plpgsql as $$
declare v public.orders;
begin
  select * into v from public.orders where id = p_order_id for update;
  if not found then raise exception 'Order % not found', p_order_id; end if;
  -- Idempotent: only a still-held order activates. A re-delivered paid webhook
  -- (order already created/fulfilled/cancelled) is a harmless no-op.
  if v.status <> 'pending_payment' then
    return v;
  end if;

  update public.orders set status = 'created' where id = p_order_id returning * into v;
  -- Reserve what's on the shelf; backorder any shortfall (the sale already
  -- happened at the store, so never hard-fail on short stock).
  perform public.apply_order_creation(p_order_id, true);
  return v;
end;
$$;

grant execute on function public.create_order(
  uuid,jsonb,uuid,text,text,date,timestamptz,text,text,text,text,text,text,text,numeric,numeric,text,boolean,boolean) to authenticated;
grant execute on function public.activate_pending_order(uuid) to authenticated;

commit;
