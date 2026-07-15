-- ============================================================================
-- Rollback for migration 0068 — non-inventory (service/fee) child SKUs.
--
-- Restores the pre-0068 function bodies (migrations 0022 / 0024 / 0027 / 0064 /
-- 0066+0067), drops the name helper, and drops child_skus.track_inventory.
--
-- Note: the one-off DATA cleanup in 0068 §6 (flagging fee children, zeroing
-- their fictional stock, clearing backorder shortfalls they caused) is NOT
-- reversed — that stock never physically existed and the flag column is gone.
-- The order.backordered flags reflect real remaining shortfalls either way.
-- ============================================================================

begin;

-- 1. upsert_store_variant — back to migration 0022 (no flag / no stock guard).
create or replace function public.upsert_store_variant(
  p_site_id          uuid,
  p_store_variant_id text,
  p_name             text,
  p_sku              text default null,
  p_price            numeric default 0,
  p_cost             numeric default null,
  p_inventory_qty    integer default null,
  p_channel          text default 'shopify'
) returns table(child_sku_id uuid, created boolean, cost_seeded boolean)
language plpgsql as $$
declare
  v_child            uuid;
  v_product          uuid;
  v_cost             numeric;
  v_existing_variant text;
  v_sku              text := nullif(btrim(coalesce(p_sku, '')), '');
  v_price            numeric := coalesce(p_price, 0);
  v_created          boolean := false;
  v_seeded           boolean := false;
begin
  if p_site_id is null or nullif(btrim(coalesce(p_store_variant_id, '')), '') is null then
    raise exception 'upsert_store_variant: site and store_variant_id are required';
  end if;

  select cs.id, cs.product_id, cs.cost into v_child, v_product, v_cost
    from public.child_skus cs
   where cs.site_id = p_site_id and cs.store_variant_id = p_store_variant_id
   limit 1;

  if v_child is not null then
    v_seeded := (p_cost is not null and coalesce(v_cost, 0) = 0);
    begin
      update public.child_skus
         set sku = v_sku, price = v_price, is_active = true,
             cost = case when v_seeded then p_cost else cost end
       where id = v_child;
    exception when unique_violation then
      update public.child_skus
         set sku = null, price = v_price, is_active = true,
             cost = case when v_seeded then p_cost else cost end
       where id = v_child;
    end;
    update public.products set name = p_name, is_active = true where id = v_product;
    v_created := false;

  elsif v_sku is not null then
    select cs.id, cs.product_id, cs.cost, cs.store_variant_id
      into v_child, v_product, v_cost, v_existing_variant
      from public.child_skus cs
     where cs.site_id = p_site_id and cs.sku = v_sku
     limit 1;

    if v_child is not null and v_existing_variant is null then
      v_seeded := (p_cost is not null and coalesce(v_cost, 0) = 0);
      update public.child_skus
         set store_variant_id = p_store_variant_id, price = v_price, is_active = true,
             cost = case when v_seeded then p_cost else cost end
       where id = v_child;
      v_created := false;
    else
      v_child := null;

      select cs.product_id into v_product
        from public.child_skus cs
       where cs.sku = v_sku and cs.site_id <> p_site_id
       limit 1;

      if v_product is not null then
        v_seeded := (p_cost is not null);
        begin
          insert into public.child_skus
            (product_id, site_id, sku, store_variant_id, price, cost)
          values (v_product, p_site_id, v_sku, p_store_variant_id, v_price, coalesce(p_cost, 0))
          returning id into v_child;
          v_created := true;
        exception when unique_violation then
          v_child := null;
        end;
      end if;

      if v_child is null then
        v_seeded := (p_cost is not null);
        insert into public.products(name) values (p_name) returning id into v_product;
        begin
          insert into public.child_skus
            (product_id, site_id, sku, store_variant_id, price, cost)
          values (v_product, p_site_id, v_sku, p_store_variant_id, v_price, coalesce(p_cost, 0))
          returning id into v_child;
        exception when unique_violation then
          insert into public.child_skus
            (product_id, site_id, sku, store_variant_id, price, cost)
          values (v_product, p_site_id, null, p_store_variant_id, v_price, coalesce(p_cost, 0))
          returning id into v_child;
        end;
        v_created := true;
      end if;
    end if;

  else
    v_seeded := (p_cost is not null);
    insert into public.products(name) values (p_name) returning id into v_product;
    insert into public.child_skus
      (product_id, site_id, sku, store_variant_id, price, cost)
    values (v_product, p_site_id, null, p_store_variant_id, v_price, coalesce(p_cost, 0))
    returning id into v_child;
    v_created := true;
  end if;

  if p_inventory_qty is not null then
    perform public.set_on_hand_to(
      v_child, p_inventory_qty, p_channel, null,
      format('Inventory synced from %s', initcap(coalesce(p_channel, 'store'))));
  end if;

  return query select v_child, v_created, v_seeded;
end;
$$;

-- 2. apply_order_creation — back to migration 0024.
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

-- 3. apply_order_fulfillment — back to migration 0027.
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

  update public.order_line_items li
     set unit_cost_snapshot = cs.cost
    from public.child_skus cs
   where li.order_id = p_order_id
     and cs.id = li.child_sku_id
     and li.unit_cost_snapshot is null;

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

-- 4. apply_order_cancellation — back to migration 0024.
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

-- 5. fulfill_order_no_stock — back to migration 0064.
create or replace function public.fulfill_order_no_stock(
  p_order_id     uuid,
  p_fulfilled_at timestamptz default null
)
returns public.orders language plpgsql as $$
declare
  v          public.orders;
  v_at       timestamptz := coalesce(p_fulfilled_at, now());
  r          record;
  v_reserved integer;
begin
  select * into v from public.orders where id = p_order_id for update;
  if not found then raise exception 'Order % not found', p_order_id; end if;
  if v.status = 'fulfilled' then raise exception 'Order % already fulfilled', p_order_id; end if;
  if v.status = 'cancelled' then raise exception 'Order % is cancelled and cannot be fulfilled', p_order_id; end if;
  if v.status = 'returned' then raise exception 'Order % is returned; re-open it before fulfilling', p_order_id; end if;
  if v.order_type <> 'standard' then
    raise exception 'fulfill_order_no_stock is for standard orders only (order % is %)', p_order_id, v.order_type;
  end if;

  update public.order_line_items li
     set unit_cost_snapshot = cs.cost
    from public.child_skus cs
   where li.order_id = p_order_id
     and cs.id = li.child_sku_id
     and li.unit_cost_snapshot is null;

  for r in
    select id, child_sku_id, quantity, backordered_qty
      from public.order_line_items where order_id = p_order_id
  loop
    v_reserved := r.quantity - coalesce(r.backordered_qty, 0);
    if v_reserved > 0 then
      perform public.release_stock(r.child_sku_id, v_reserved, 'order_line_item', r.id);
    end if;
    if coalesce(r.backordered_qty, 0) > 0 then
      update public.order_line_items set backordered_qty = 0 where id = r.id;
    end if;
  end loop;

  update public.orders
     set status = 'fulfilled',
         fulfilled_at = v_at,
         auto_fulfilled = true,
         backordered = false
   where id = p_order_id returning * into v;

  update public.fulfillment_groups g set status = 'fulfilled', fulfilled_at = v_at
   where g.id = v.group_id
     and not exists (select 1 from public.orders o where o.group_id = g.id and o.status <> 'fulfilled');
  return v;
end;
$$;

-- 6. force_fulfill_order — back to migration 0066 body with 0067 SECURITY DEFINER.
create or replace function public.force_fulfill_order(
  p_order_id     uuid,
  p_reason       text,
  p_fulfilled_at timestamptz default null
)
returns public.orders language plpgsql security definer set search_path = '' as $$
declare
  v          public.orders;
  v_at       timestamptz := coalesce(p_fulfilled_at, now());
  v_reason   text := nullif(trim(coalesce(p_reason, '')), '');
  r          record;
  v_reserved integer;
  v_short    integer;
  v_any_row  boolean := false;
  v_first    uuid;
begin
  if public.app_role() not in ('admin', 'manager') then
    raise exception 'force_fulfill_order requires the admin or manager role'
      using errcode = 'insufficient_privilege';
  end if;
  if v_reason is null then
    raise exception 'force_fulfill_order requires a reason (it is written to the audit log)';
  end if;

  select * into v from public.orders where id = p_order_id for update;
  if not found then raise exception 'Order % not found', p_order_id; end if;
  if v.status = 'fulfilled' then raise exception 'Order % already fulfilled', p_order_id; end if;
  if v.status = 'cancelled' then raise exception 'Order % is cancelled and cannot be fulfilled', p_order_id; end if;
  if v.status = 'returned' then raise exception 'Order % is returned; re-open it before fulfilling', p_order_id; end if;
  if v.order_type <> 'standard' then
    raise exception 'force_fulfill_order is for standard orders only (order % is %)', p_order_id, v.order_type;
  end if;

  update public.order_line_items li
     set unit_cost_snapshot = cs.cost
    from public.child_skus cs
   where li.order_id = p_order_id
     and cs.id = li.child_sku_id
     and li.unit_cost_snapshot is null;

  for r in
    select id, child_sku_id, quantity, coalesce(backordered_qty, 0) as backordered_qty
      from public.order_line_items where order_id = p_order_id
     order by id
  loop
    if v_first is null then v_first := r.child_sku_id; end if;

    v_reserved := r.quantity - r.backordered_qty;
    if v_reserved > 0 then
      perform public.release_stock(r.child_sku_id, v_reserved, 'order_line_item', r.id);
    end if;

    v_short := r.backordered_qty;
    if v_short > 0 then
      perform public._inv_write(
        r.child_sku_id, 0, 0, 0, 'correction', 'order', p_order_id,
        format('Force fulfill: %s — %s unit(s) shipped without stock', v_reason, v_short));
      update public.order_line_items set backordered_qty = 0 where id = r.id;
      v_any_row := true;
    end if;
  end loop;

  if not v_any_row and v_first is not null then
    perform public._inv_write(
      v_first, 0, 0, 0, 'correction', 'order', p_order_id,
      format('Force fulfill: %s', v_reason));
  end if;

  update public.orders
     set status = 'fulfilled',
         fulfilled_at = v_at,
         backordered = false
   where id = p_order_id returning * into v;

  perform public.charge_order_pick_fee(p_order_id);

  update public.fulfillment_groups g set status = 'fulfilled', fulfilled_at = v_at
   where g.id = v.group_id
     and not exists (select 1 from public.orders o where o.group_id = g.id and o.status <> 'fulfilled');
  return v;
end;
$$;

-- 7. Drop the helper and the column.
drop function if exists public.is_noninventory_name(text);
alter table public.child_skus drop column if exists track_inventory;

commit;
