-- ============================================================================
-- WMS — Migration 0068: non-inventory (service/fee) child SKUs
--
-- Problem: Route's "Shipping Protection" Shopify plugin mints a separate product
-- per price point (e.g. "Shipping Protection by Route - 3.95"), and each one is
-- synced into WMS WITH a stock level, because that's how the plugin represents
-- itself on the store. These are fees, not physical goods — they can never hold
-- real stock. Today they flow through apply_order_creation() like any SKU:
-- reserve_available() finds nothing real, records the shortfall as
-- backordered_qty, and flips orders.backordered = true. Result: every order that
-- carries a protection line looks backordered and can't fulfil.
--
-- Fix: mark such children non-inventory (child_skus.track_inventory = false).
-- Their order lines import and keep their revenue, but they SKIP every inventory
-- op — never reserve, never backorder, never consume, never release, and store
-- "stock" for them is ignored on sync. The flag is name-driven for the Route
-- pattern (is_noninventory_name) but is a plain column, so anything can be
-- flagged by hand later.
--
-- Touches six guarded functions. CREATE OR REPLACE resets unspecified
-- attributes, so any SECURITY DEFINER / pinned search_path is re-declared to
-- match the prior definition (migrations 0003/0024/0027/0067) — omitting them
-- would silently unlock the inventory door.
--
-- Reverse with the matching rollback/…0068….down.sql.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Column + name helper
-- ---------------------------------------------------------------------------
alter table public.child_skus
  add column if not exists track_inventory boolean not null default true;

comment on column public.child_skus.track_inventory is
  'When false the SKU is a service/fee line (e.g. Route Shipping Protection): '
  'it never reserves, backorders, consumes, releases, or receives stock. '
  'Default true = normal physical inventory.';

-- Central definition of the fee/service name pattern, so the sync path and the
-- one-off cleanup below agree exactly. Deliberately narrow to avoid flagging a
-- real product; broaden here if other fee plugins appear.
create or replace function public.is_noninventory_name(p_name text)
returns boolean language sql immutable as $$
  select coalesce(p_name, '') ilike 'shipping protection%';
$$;

-- ---------------------------------------------------------------------------
-- 2. apply_order_creation — skip reservation for non-inventory lines
--    (re-declared from migration 0024)
-- ---------------------------------------------------------------------------
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
    select oli.id, oli.child_sku_id, oli.quantity, cs.track_inventory
      from public.order_line_items oli
      join public.child_skus cs on cs.id = oli.child_sku_id
     where oli.order_id = p_order_id
  loop
    -- Service/fee line (fictional stock): never touches inventory, never owed.
    if not r.track_inventory then
      continue;
    end if;

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
-- 3. apply_order_fulfillment — skip consume for non-inventory lines
--    (re-declared from migration 0027)
-- ---------------------------------------------------------------------------
create or replace function public.apply_order_fulfillment(p_order_id uuid)
returns void language plpgsql as $$
declare r record; v_type text; v_back integer;
begin
  select order_type into v_type from public.orders where id = p_order_id;
  if v_type is null then raise exception 'Order % not found', p_order_id; end if;

  -- Backorder guard (migration 0024): can't ship while units are owed. Service
  -- lines never carry backordered_qty, so they never block this.
  select coalesce(sum(backordered_qty), 0) into v_back
    from public.order_line_items where order_id = p_order_id;
  if v_back > 0 then
    raise exception
      'Cannot fulfill order %: % unit(s) still backordered awaiting stock',
      p_order_id, v_back using errcode = 'check_violation';
  end if;

  -- COGS basis (migration 0019): freeze current cost at the sale moment; fills
  -- nulls only. Harmless for service lines (cost 0).
  update public.order_line_items li
     set unit_cost_snapshot = cs.cost
    from public.child_skus cs
   where li.order_id = p_order_id
     and cs.id = li.child_sku_id
     and li.unit_cost_snapshot is null;

  for r in
    select oli.id, oli.child_sku_id, oli.quantity, cs.track_inventory
      from public.order_line_items oli
      join public.child_skus cs on cs.id = oli.child_sku_id
     where oli.order_id = p_order_id
  loop
    if not r.track_inventory then
      continue;   -- fee line: nothing to consume
    end if;
    if v_type = 'layaway' then
      perform public.layaway_consume(r.child_sku_id, r.quantity, 'order_line_item', r.id);
    else
      perform public.consume_stock(r.child_sku_id, r.quantity, 'order_line_item', r.id);
    end if;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. apply_order_cancellation — skip release for non-inventory lines
--    (re-declared from migration 0024)
-- ---------------------------------------------------------------------------
create or replace function public.apply_order_cancellation(p_order_id uuid)
returns void language plpgsql as $$
declare r record; v_type text; v_reserved integer;
begin
  select order_type into v_type from public.orders where id = p_order_id;
  if v_type is null then raise exception 'Order % not found', p_order_id; end if;
  for r in
    select oli.id, oli.child_sku_id, oli.quantity, oli.backordered_qty, cs.track_inventory
      from public.order_line_items oli
      join public.child_skus cs on cs.id = oli.child_sku_id
     where oli.order_id = p_order_id
  loop
    if not r.track_inventory then
      continue;   -- fee line: nothing was reserved, nothing to release
    end if;
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
-- 5. upsert_store_variant — auto-flag fee products on sync + skip stock apply
--    (re-declared from migration 0022)
-- ---------------------------------------------------------------------------
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

  -- 1. Same variant already mapped at this site -> update in place (idempotent).
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
    -- The owning store may rename its own variant.
    update public.products set name = p_name, is_active = true where id = v_product;
    v_created := false;

  elsif v_sku is not null then
    -- 2a. Adopt an existing same-site SKU that isn't bound to a variant yet.
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
      v_created := false;  -- reused an existing child; don't rename its parent
    else
      v_child := null;

      -- 2b. Same SKU at another site -> attach a new child to that master.
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
          v_child := null;  -- pre-existing collision; fall through to a new parent
        end;
      end if;

      -- 2c. No usable SKU match -> new master product.
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
    -- 3. No SKU to reconcile on -> new master product (legacy behaviour).
    v_seeded := (p_cost is not null);
    insert into public.products(name) values (p_name) returning id into v_product;
    insert into public.child_skus
      (product_id, site_id, sku, store_variant_id, price, cost)
    values (v_product, p_site_id, null, p_store_variant_id, v_price, coalesce(p_cost, 0))
    returning id into v_child;
    v_created := true;
  end if;

  -- Fee/service products (e.g. Route "Shipping Protection") must never carry
  -- real stock. Force the flag off by name; never force it back on, so a manual
  -- non-inventory flag on a normal product is not clobbered by a resync.
  if public.is_noninventory_name(p_name) then
    update public.child_skus set track_inventory = false where id = v_child;
  end if;

  -- Pull store stock into WMS on_hand, but ONLY for inventory-tracked children.
  -- A fee line's store "stock" is fictional and must be ignored.
  if p_inventory_qty is not null
     and exists (select 1 from public.child_skus
                  where id = v_child and track_inventory) then
    perform public.set_on_hand_to(
      v_child, p_inventory_qty, p_channel, null,
      format('Inventory synced from %s', initcap(coalesce(p_channel, 'store'))));
  end if;

  return query select v_child, v_created, v_seeded;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5b. fulfill_order_no_stock — skip release for non-inventory lines
--     (re-declared from migration 0064; release_stock hard-fails when reserved
--     < qty, and a fee line was never reserved). SECURITY INVOKER, as before.
-- ---------------------------------------------------------------------------
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

  -- COGS basis (mirrors apply_order_fulfillment): freeze current cost, nulls only.
  update public.order_line_items li
     set unit_cost_snapshot = cs.cost
    from public.child_skus cs
   where li.order_id = p_order_id
     and cs.id = li.child_sku_id
     and li.unit_cost_snapshot is null;

  -- Inventory-neutral: release the reserved portion, clear the backorder, but
  -- never touch on_hand. Fee lines were never reserved, so skip their release.
  for r in
    select oli.id, oli.child_sku_id, oli.quantity, oli.backordered_qty, cs.track_inventory
      from public.order_line_items oli
      join public.child_skus cs on cs.id = oli.child_sku_id
     where oli.order_id = p_order_id
  loop
    if r.track_inventory then
      v_reserved := r.quantity - coalesce(r.backordered_qty, 0);
      if v_reserved > 0 then
        perform public.release_stock(r.child_sku_id, v_reserved, 'order_line_item', r.id);
      end if;
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

-- ---------------------------------------------------------------------------
-- 5c. force_fulfill_order — skip release for non-inventory lines
--     (re-declared from migrations 0066/0067). MUST re-assert SECURITY DEFINER +
--     empty search_path (0067): it calls _inv_write directly, sealed by 0003.
-- ---------------------------------------------------------------------------
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
  -- Permission gate: only elevated roles may bypass the backorder guard.
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

  -- COGS basis (mirrors apply_order_fulfillment): freeze current cost, nulls only.
  update public.order_line_items li
     set unit_cost_snapshot = cs.cost
    from public.child_skus cs
   where li.order_id = p_order_id
     and cs.id = li.child_sku_id
     and li.unit_cost_snapshot is null;

  -- Inventory-neutral: give back the reserved portion (as if the order closed),
  -- leave on_hand alone, and stamp an audit row for every line short of stock.
  -- Fee lines were never reserved and never owed, so they release nothing.
  for r in
    select oli.id, oli.child_sku_id, oli.quantity,
           coalesce(oli.backordered_qty, 0) as backordered_qty, cs.track_inventory
      from public.order_line_items oli
      join public.child_skus cs on cs.id = oli.child_sku_id
     where oli.order_id = p_order_id
     order by oli.id
  loop
    if v_first is null then v_first := r.child_sku_id; end if;

    if r.track_inventory then
      v_reserved := r.quantity - r.backordered_qty;
      if v_reserved > 0 then
        perform public.release_stock(r.child_sku_id, v_reserved, 'order_line_item', r.id);
      end if;

      v_short := r.backordered_qty;
      if v_short > 0 then
        -- Zero-delta ledger row = pure audit note (no stock change), actor stamped.
        perform public._inv_write(
          r.child_sku_id, 0, 0, 0, 'correction', 'order', p_order_id,
          format('Force fulfill: %s — %s unit(s) shipped without stock', v_reason, v_short));
        update public.order_line_items set backordered_qty = 0 where id = r.id;
        v_any_row := true;
      end if;
    end if;
  end loop;

  -- Guarantee the reason is captured even if nothing was actually backordered.
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

  -- Locally picked/packed, so it earns the pick fee (unlike store completions).
  perform public.charge_order_pick_fee(p_order_id);

  update public.fulfillment_groups g set status = 'fulfilled', fulfilled_at = v_at
   where g.id = v.group_id
     and not exists (select 1 from public.orders o where o.group_id = g.id and o.status <> 'fulfilled');
  return v;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. One-off cleanup of already-synced fee products (approved: clean up now)
-- ---------------------------------------------------------------------------

-- 6a. Flag every child whose parent name matches the fee pattern.
update public.child_skus cs
   set track_inventory = false
  from public.products p
 where p.id = cs.product_id
   and cs.track_inventory
   and public.is_noninventory_name(p.name);

-- 6b. Zero any fictional stock/reservations these fake products accumulated so
--     inventory reports read clean. Direct level reset (not the ledger): the
--     stock never physically existed, so there is nothing real to audit.
update public.inventory_levels il
   set on_hand = 0, reserved = 0, layby = 0, updated_at = now()
  from public.child_skus cs
 where cs.id = il.child_sku_id
   and cs.track_inventory = false
   and (il.on_hand <> 0 or il.reserved <> 0 or il.layby <> 0);

-- 6c. Clear backorder shortfalls that these fee lines created.
update public.order_line_items oli
   set backordered_qty = 0
  from public.child_skus cs
 where cs.id = oli.child_sku_id
   and cs.track_inventory = false
   and oli.backordered_qty > 0;

-- 6d. Recompute the order-level flag for every active order (idempotent): an
--     order stays flagged only if a REAL line is still short.
update public.orders o
   set backordered = exists (
     select 1 from public.order_line_items x
      where x.order_id = o.id and x.backordered_qty > 0)
 where o.status not in ('fulfilled','cancelled')
   and o.backordered is distinct from exists (
     select 1 from public.order_line_items x
      where x.order_id = o.id and x.backordered_qty > 0);

commit;
