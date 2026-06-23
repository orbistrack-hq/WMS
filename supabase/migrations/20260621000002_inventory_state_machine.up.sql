-- ============================================================================
-- WMS — Migration 0002: inventory state machine
--
-- The reservation lifecycle and layaway lifecycle, expressed as guarded,
-- atomic functions. Every public function:
--   1. locks the inventory_levels row (SELECT ... FOR UPDATE) so concurrent
--      moves on the same SKU serialize and cannot oversell,
--   2. validates the transition with a clear error message,
--   3. writes the level change and a matching inventory_ledger row together,
--      so the materialized levels and the append-only ledger never drift.
--
-- Standard order:  reserve -> (release on cancel | consume on fulfill)
-- Layaway order:   book    -> (cancel  on cancel | consume on fulfill)
-- Plus: receive (stock in) and adjust (manual correction).
--
-- Idempotency note: these apply a single transition each. Ensuring a transition
-- runs exactly once per order (e.g. not reserving twice) is the job of the
-- order status-transition layer in the Orders module — it owns "created can
-- only move to fulfilled once". These functions are the atomic primitives it
-- calls inside that transaction.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. Extend the ledger reason vocabulary for the layaway transitions.
-- ----------------------------------------------------------------------------
alter table public.inventory_ledger drop constraint inventory_ledger_reason_check;
alter table public.inventory_ledger add constraint inventory_ledger_reason_check
  check (reason in (
    'order_reserve','order_release','order_consume',
    'layaway_remove','layaway_cancel','layaway_consume',
    'manual_adjustment','receipt','correction'));

-- ----------------------------------------------------------------------------
-- 2. Internal writer — applies deltas and records the ledger row.
--    Assumes the caller already locked the row and validated the transition.
--    SECURITY INVOKER (default): runs as the caller, so RLS still applies and
--    the ledger actor is the real auth.uid().
-- ----------------------------------------------------------------------------
create or replace function public._inv_write(
  p_child_sku_id uuid,
  p_d_on_hand    integer,
  p_d_reserved   integer,
  p_d_layby      integer,
  p_reason       text,
  p_ref_type     text,
  p_ref_id       uuid,
  p_note         text
) returns public.inventory_levels
language plpgsql as $$
declare v public.inventory_levels;
begin
  update public.inventory_levels
     set on_hand  = on_hand  + p_d_on_hand,
         reserved = reserved + p_d_reserved,
         layby    = layby    + p_d_layby
   where child_sku_id = p_child_sku_id
   returning * into v;

  insert into public.inventory_ledger(
    child_sku_id, delta_on_hand, delta_reserved, delta_layby,
    reason, reference_type, reference_id, note, actor)
  values (p_child_sku_id, p_d_on_hand, p_d_reserved, p_d_layby,
    p_reason, p_ref_type, p_ref_id, p_note, auth.uid());

  return v;
end;
$$;

-- Lock + fetch helper. Raises a clean error if the SKU has no level row.
create or replace function public._inv_lock(p_child_sku_id uuid)
returns public.inventory_levels
language plpgsql as $$
declare v public.inventory_levels;
begin
  select * into v from public.inventory_levels
   where child_sku_id = p_child_sku_id for update;
  if not found then
    raise exception 'No inventory row for child SKU %', p_child_sku_id
      using errcode = 'no_data_found';
  end if;
  return v;
end;
$$;

-- ----------------------------------------------------------------------------
-- 3. Standard reservation lifecycle
-- ----------------------------------------------------------------------------
-- reserve: set stock aside. Requires available (on_hand - reserved) >= qty.
create or replace function public.reserve_stock(
  p_child_sku_id uuid, p_qty integer,
  p_ref_type text default 'order_line_item', p_ref_id uuid default null
) returns public.inventory_levels
language plpgsql as $$
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

-- release: order cancelled, give the reservation back. Requires reserved >= qty.
create or replace function public.release_stock(
  p_child_sku_id uuid, p_qty integer,
  p_ref_type text default 'order_line_item', p_ref_id uuid default null
) returns public.inventory_levels
language plpgsql as $$
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

-- consume: order fulfilled, reserved stock ships. Drops both on_hand and reserved.
create or replace function public.consume_stock(
  p_child_sku_id uuid, p_qty integer,
  p_ref_type text default 'order_line_item', p_ref_id uuid default null
) returns public.inventory_levels
language plpgsql as $$
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

-- ----------------------------------------------------------------------------
-- 4. Layaway lifecycle (stock leaves on_hand at booking; tracked in layby)
-- ----------------------------------------------------------------------------
-- book: remove from sellable stock now. Same availability guard as reserve.
create or replace function public.layaway_book(
  p_child_sku_id uuid, p_qty integer,
  p_ref_type text default 'order_line_item', p_ref_id uuid default null
) returns public.inventory_levels
language plpgsql as $$
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

-- cancel: layaway abandoned, stock returns to sellable. Requires layby >= qty.
create or replace function public.layaway_cancel(
  p_child_sku_id uuid, p_qty integer,
  p_ref_type text default 'order_line_item', p_ref_id uuid default null
) returns public.inventory_levels
language plpgsql as $$
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

-- consume: layaway paid off and shipped. on_hand already dropped at booking,
-- so only the layby counter clears. Requires layby >= qty.
create or replace function public.layaway_consume(
  p_child_sku_id uuid, p_qty integer,
  p_ref_type text default 'order_line_item', p_ref_id uuid default null
) returns public.inventory_levels
language plpgsql as $$
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

-- ----------------------------------------------------------------------------
-- 5. Stock in / manual correction
-- ----------------------------------------------------------------------------
-- receive: stock arrives.
create or replace function public.receive_stock(
  p_child_sku_id uuid, p_qty integer,
  p_ref_type text default 'receipt', p_ref_id uuid default null, p_note text default null
) returns public.inventory_levels
language plpgsql as $$
begin
  if p_qty <= 0 then raise exception 'receive qty must be positive (got %)', p_qty; end if;
  perform public._inv_lock(p_child_sku_id);
  return public._inv_write(p_child_sku_id, p_qty, 0, 0, 'receipt', p_ref_type, p_ref_id, p_note);
end;
$$;

-- adjust: signed correction to on_hand (stock count, damage, etc.). The CHECK
-- constraints are the backstop; we pre-validate for a friendlier message.
create or replace function public.adjust_stock(
  p_child_sku_id uuid, p_delta integer, p_note text,
  p_ref_type text default 'manual', p_ref_id uuid default null
) returns public.inventory_levels
language plpgsql as $$
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
  return public._inv_write(p_child_sku_id, p_delta, 0, 0, 'manual_adjustment', p_ref_type, p_ref_id, p_note);
end;
$$;

-- ----------------------------------------------------------------------------
-- 6. Order-level orchestrators — apply the correct primitive to every line,
--    branching on order_type. The Orders module calls these at the matching
--    status transition (created / cancelled / fulfilled).
-- ----------------------------------------------------------------------------
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

commit;
