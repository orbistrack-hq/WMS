-- ============================================================================
-- WMS — Migration 0024: explicit backorder state
--
-- Problem: create_order reserves every line through reserve_stock(), which HARD
-- FAILS when available stock is short. That's correct for hand-entered orders
-- (don't let staff oversell), but wrong for store imports: the sale already
-- happened on Shopify/Woo, so refusing the import loses the order.
--
-- Model (confirmed with the team):
--   * Reserve what's available now; record the shortfall as backordered_qty on
--     the line. Inventory NEVER goes negative.
--   * orders.backordered flags any order with an unmet line. It is ORTHOGONAL to
--     the lifecycle status (created/picking/.../fulfilled) so the pick/pack flow
--     is untouched — a backordered order is just an open order with a warning.
--   * Only the import path opts in (p_allow_backorder). Manual create_order keeps
--     hard-failing on short stock.
--   * When stock arrives (manual adjustment or store sync), backorders are
--     auto-promoted oldest-order-first: the now-available units get reserved and
--     backordered_qty shrinks; the flag clears when the order is whole again.
--
-- Reservation accounting ripples into cancel/fulfill: a line's RESERVED amount
-- is (quantity - backordered_qty), so cancellation releases only that part, and
-- fulfillment is blocked while anything is still backordered (you can't ship what
-- you never reserved).
--
-- NOTE: recreated guarded functions re-declare SECURITY DEFINER / search_path
-- because CREATE OR REPLACE resets unspecified attributes — omitting them would
-- silently unlock the inventory door (migration 0003).
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------
alter table public.order_line_items
  add column backordered_qty integer not null default 0;
alter table public.order_line_items
  add constraint oli_backordered_within_qty
  check (backordered_qty >= 0 and backordered_qty <= quantity);

alter table public.orders
  add column backordered boolean not null default false;

comment on column public.order_line_items.backordered_qty is
  'Units on this line not yet reserved because stock was short at creation. reserved = quantity - backordered_qty. Auto-promoted to 0 as stock arrives.';
comment on column public.orders.backordered is
  'True while any line has backordered_qty > 0. Orthogonal to status; a flag, not a lifecycle stage.';

-- ---------------------------------------------------------------------------
-- 2. reserve_available: reserve up to what's on the shelf, never negative.
--    Returns the number of units actually reserved (caller derives shortfall).
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 3. apply_order_creation — gains p_allow_backorder. Drop the 1-arg signature
--    first so the new default-arg version doesn't create an ambiguous overload.
-- ---------------------------------------------------------------------------
drop function if exists public.create_order(
  uuid,jsonb,uuid,text,text,date,timestamptz,text,text,text,text,text,text,text,numeric,numeric,text);
drop function if exists public.apply_order_creation(uuid);

create or replace function public.apply_order_creation(
  p_order_id uuid, p_allow_backorder boolean default false
) returns void language plpgsql as $$
declare
  r record; v_type text; v_reserved integer; v_short integer;
  v_any_back boolean := false;
begin
  select order_type into v_type from public.orders where id = p_order_id;
  if v_type is null then raise exception 'Order % not found', p_order_id; end if;

  for r in
    select id, child_sku_id, quantity
      from public.order_line_items where order_id = p_order_id
  loop
    if v_type = 'layaway' then
      perform public.layaway_book(r.child_sku_id, r.quantity, 'order_line_item', r.id);
    elsif p_allow_backorder then
      v_reserved := public.reserve_available(
        r.child_sku_id, r.quantity, 'order_line_item', r.id);
      v_short := r.quantity - v_reserved;
      if v_short > 0 then
        update public.order_line_items set backordered_qty = v_short where id = r.id;
        v_any_back := true;
      end if;
    else
      perform public.reserve_stock(r.child_sku_id, r.quantity, 'order_line_item', r.id);
    end if;
  end loop;

  if v_any_back then
    update public.orders set backordered = true where id = p_order_id;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. create_order — same body as migration 0010 plus a trailing
--    p_allow_backorder that flows into apply_order_creation.
-- ---------------------------------------------------------------------------
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

  -- Guarded path: reserve (standard) / book layaway / backorder the shortfall.
  perform public.apply_order_creation(v_order_id, p_allow_backorder);

  return v_order_id;
end;
$$;

comment on function public.create_order is
  'Atomically opens a fulfillment group, writes the order + line items, and reserves/lays-away stock. With p_allow_backorder, short lines are backordered instead of failing. Returns the new order id.';

-- ---------------------------------------------------------------------------
-- 5. Cancellation releases only the RESERVED portion (quantity - backordered).
-- ---------------------------------------------------------------------------
create or replace function public.apply_order_cancellation(p_order_id uuid)
returns void language plpgsql as $$
declare r record; v_type text; v_reserved integer;
begin
  select order_type into v_type from public.orders where id = p_order_id;
  if v_type is null then raise exception 'Order % not found', p_order_id; end if;
  for r in
    select id, child_sku_id, quantity, backordered_qty
      from public.order_line_items where order_id = p_order_id
  loop
    if v_type = 'layaway' then
      perform public.layaway_cancel(r.child_sku_id, r.quantity, 'order_line_item', r.id);
    else
      v_reserved := r.quantity - coalesce(r.backordered_qty, 0);
      if v_reserved > 0 then
        perform public.release_stock(r.child_sku_id, v_reserved, 'order_line_item', r.id);
      end if;
    end if;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Fulfillment is blocked while any line is still backordered.
-- ---------------------------------------------------------------------------
create or replace function public.apply_order_fulfillment(p_order_id uuid)
returns void language plpgsql as $$
declare r record; v_type text; v_back integer;
begin
  select order_type into v_type from public.orders where id = p_order_id;
  if v_type is null then raise exception 'Order % not found', p_order_id; end if;

  select coalesce(sum(backordered_qty), 0) into v_back
    from public.order_line_items where order_id = p_order_id;
  if v_back > 0 then
    raise exception
      'Cannot fulfill order %: % unit(s) still backordered awaiting stock',
      p_order_id, v_back using errcode = 'check_violation';
  end if;

  for r in
    select id, child_sku_id, quantity
      from public.order_line_items where order_id = p_order_id
  loop
    if v_type = 'layaway' then
      perform public.layaway_consume(r.child_sku_id, r.quantity, 'order_line_item', r.id);
    else
      perform public.consume_stock(r.child_sku_id, r.quantity, 'order_line_item', r.id);
    end if;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. promote_backorders: spread newly-available stock to waiting lines,
--    oldest order first. Returns units promoted.
-- ---------------------------------------------------------------------------
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
    exit when v_take = 0;   -- shelf is empty; nothing left to spread
    update public.order_line_items
       set backordered_qty = backordered_qty - v_take
     where id = r.id;
    v_total := v_total + v_take;
  end loop;

  -- Refresh the order flag for every active order holding this SKU.
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

-- ---------------------------------------------------------------------------
-- 8. Wire promotion into the two paths that ADD stock. Both recreated with
--    SECURITY DEFINER + pinned search_path (see header note).
-- ---------------------------------------------------------------------------
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
    v := public._inv_lock(p_child_sku_id);   -- reflect reservations just made
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

-- ---------------------------------------------------------------------------
-- 9. Grants (explicit; defaults also apply). Definer guards stay callable by
--    the app role exactly like the other inventory transition functions.
-- ---------------------------------------------------------------------------
grant execute on function public.reserve_available(uuid,integer,text,uuid) to authenticated;
grant execute on function public.promote_backorders(uuid) to authenticated;
grant execute on function public.create_order(
  uuid,jsonb,uuid,text,text,date,timestamptz,text,text,text,text,text,text,text,numeric,numeric,text,boolean) to authenticated;

commit;
