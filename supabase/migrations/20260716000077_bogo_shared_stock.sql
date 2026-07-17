-- ============================================================================
-- WMS — Migration 0077: BOGO shared stock (delegating child SKUs)
--
-- A BOGO "free" child SKU is real and cost-bearing (price 0, cost = jar cost)
-- but holds NO stock of its own: every order stock movement it triggers resolves
-- to its PAID counterpart's inventory pool. Sales and cost stay on the BOGO line
-- (so BOGO vs. paid remain separable in reporting); only the stock quantity is
-- shared. See BOGO-SHARED-STOCK-SPEC.md.
--
-- Design:
--   * delegates_to_child_sku_id points a BOGO child at its paid counterpart.
--   * _stock_sku(id) = coalesce(delegates_to, id). Resolved at the top of the
--     ORDER stock primitives (reserve/release/consume/layaway + reserve_available)
--     so the ledger and reserved counters land on the paid pool, and NO order
--     path is missed. Cost snapshot + order_line_items keep the BOGO SKU.
--   * Manual add-stock paths (receive_stock, adjust_stock) BLOCK a delegate with
--     a clear message; the automated Shopify set_on_hand_to no-ops on a delegate.
--   * promote_backorders matches lines whose stock SKU resolves to the received
--     SKU, so a receipt on the paid SKU promotes backordered BOGO lines.
--   * adopt_bogo_sku(bogo, paid) does the one-step catalog cleanup; auto_adopt_bogo()
--     merges every UNAMBIGUOUS flagged twin automatically (deterministic key:
--     same site, base-normalized SKU match, equal cost, price>0, exactly one
--     candidate). Ambiguous ones stay flagged for manual review.
--
-- All recreated inventory functions re-declare SECURITY DEFINER + pinned
-- search_path (set by migration 0003) — omitting them would silently unlock the
-- inventory door. Reverse with rollback/20260716000077_bogo_shared_stock.down.sql.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Delegation pointer + integrity guard
-- ---------------------------------------------------------------------------
alter table public.child_skus
  add column if not exists delegates_to_child_sku_id uuid
    references public.child_skus(id) on delete restrict;

comment on column public.child_skus.delegates_to_child_sku_id is
  'When set, this SKU (a BOGO / give-away twin) holds no stock of its own; all '
  'order stock movement resolves to the referenced paid counterpart''s pool via '
  '_stock_sku(). Target must be a non-delegate at the same site and product. '
  'Sales and cost stay on THIS SKU; only stock is shared.';

create index if not exists child_skus_delegates_to_idx
  on public.child_skus(delegates_to_child_sku_id)
  where delegates_to_child_sku_id is not null;

-- Cross-row invariants can't live in a CHECK, so guard with a trigger.
create or replace function public.validate_sku_delegate()
returns trigger language plpgsql
security definer set search_path = '' as $$
declare t public.child_skus;
begin
  if new.delegates_to_child_sku_id is null then
    return new;
  end if;
  if new.delegates_to_child_sku_id = new.id then
    raise exception 'a SKU cannot delegate stock to itself (%)', new.id
      using errcode = 'check_violation';
  end if;
  select * into t from public.child_skus where id = new.delegates_to_child_sku_id;
  if not found then
    raise exception 'delegate target % does not exist', new.delegates_to_child_sku_id
      using errcode = 'foreign_key_violation';
  end if;
  if t.delegates_to_child_sku_id is not null then
    raise exception 'delegate target % is itself a delegate — no chains', t.id
      using errcode = 'check_violation';
  end if;
  if t.site_id <> new.site_id then
    raise exception 'delegate target % is at a different site', t.id
      using errcode = 'check_violation';
  end if;
  if t.product_id <> new.product_id then
    raise exception 'delegate target % is under a different product — re-parent first', t.id
      using errcode = 'check_violation';
  end if;
  -- A SKU that others delegate TO cannot itself become a delegate.
  if exists (select 1 from public.child_skus o
              where o.delegates_to_child_sku_id = new.id) then
    raise exception 'SKU % is a delegate target and cannot itself delegate', new.id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists t_childskus_validate_delegate on public.child_skus;
create trigger t_childskus_validate_delegate
  before insert or update of delegates_to_child_sku_id, product_id, site_id
  on public.child_skus
  for each row execute function public.validate_sku_delegate();

-- ---------------------------------------------------------------------------
-- 2. Stock-SKU resolver
-- ---------------------------------------------------------------------------
create or replace function public._stock_sku(p_child_sku_id uuid)
returns uuid language sql stable
security definer set search_path = '' as $$
  select coalesce(cs.delegates_to_child_sku_id, cs.id)
  from public.child_skus cs where cs.id = p_child_sku_id;
$$;

-- Adopted delegates are resolved, never "suspected". Teach the 0076 flag trigger
-- to leave them alone (also stops adopt() from re-flagging via price0/cost>0).
create or replace function public.flag_suspected_duplicate()
returns trigger language plpgsql
security definer set search_path = '' as $$
begin
  if new.delegates_to_child_sku_id is not null then
    new.suspected_duplicate := false;
    return new;
  end if;
  new.suspected_duplicate := public._is_suspected_duplicate(
    new.id, new.site_id, new.sku, new.price, new.cost, new.track_inventory);
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Order stock primitives — resolve delegation at the top
-- ---------------------------------------------------------------------------
create or replace function public.reserve_stock(
  p_child_sku_id uuid, p_qty integer,
  p_ref_type text default 'order_line_item', p_ref_id uuid default null
) returns public.inventory_levels
language plpgsql security definer set search_path = '' as $$
declare v public.inventory_levels;
begin
  if p_qty <= 0 then raise exception 'reserve qty must be positive (got %)', p_qty; end if;
  p_child_sku_id := public._stock_sku(p_child_sku_id);
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
  p_child_sku_id := public._stock_sku(p_child_sku_id);
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
  p_child_sku_id := public._stock_sku(p_child_sku_id);
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
  p_child_sku_id := public._stock_sku(p_child_sku_id);
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
  p_child_sku_id := public._stock_sku(p_child_sku_id);
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
  p_child_sku_id := public._stock_sku(p_child_sku_id);
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
  p_child_sku_id := public._stock_sku(p_child_sku_id);
  v := public._inv_lock(p_child_sku_id);
  if v.layby < p_qty then
    raise exception 'Cannot consume more layby than held for %: layby %, requested %',
      p_child_sku_id, v.layby, p_qty using errcode = 'check_violation';
  end if;
  return public._inv_write(p_child_sku_id, 0, 0, -p_qty, 'layaway_consume', p_ref_type, p_ref_id, null);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Add-stock paths — a delegate has no pool of its own
-- ---------------------------------------------------------------------------
create or replace function public.receive_stock(
  p_child_sku_id uuid, p_qty integer,
  p_ref_type text default 'receipt', p_ref_id uuid default null, p_note text default null
) returns public.inventory_levels
language plpgsql security definer set search_path = '' as $$
declare v public.inventory_levels;
begin
  if p_qty <= 0 then raise exception 'receive qty must be positive (got %)', p_qty; end if;
  if public._stock_sku(p_child_sku_id) <> p_child_sku_id then
    raise exception 'SKU % shares stock with % — receive into the paid SKU instead',
      p_child_sku_id, public._stock_sku(p_child_sku_id) using errcode = 'check_violation';
  end if;
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
  if public._stock_sku(p_child_sku_id) <> p_child_sku_id then
    raise exception 'SKU % shares stock with % — adjust the paid SKU instead',
      p_child_sku_id, public._stock_sku(p_child_sku_id) using errcode = 'check_violation';
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
  -- A delegate publishes/holds no stock of its own; automated sync is a no-op.
  if public._stock_sku(p_child_sku_id) <> p_child_sku_id then
    return public._inv_lock(p_child_sku_id);
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
-- 5. promote_backorders — match lines whose STOCK sku resolves to the receipt
-- ---------------------------------------------------------------------------
create or replace function public.promote_backorders(p_child_sku_id uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare r record; v_take integer; v_total integer := 0;
begin
  for r in
    select oli.id, oli.backordered_qty
      from public.order_line_items oli
      join public.orders o on o.id = oli.order_id
     where public._stock_sku(oli.child_sku_id) = p_child_sku_id
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
        where y.order_id = o.id
          and public._stock_sku(y.child_sku_id) = p_child_sku_id);

  return v_total;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Base-normalized SKU (strips a trailing BOGO token so both the dash-mangled
--    twins and the proper "<paid>-BOGO" suffix resolve to the paid base code).
-- ---------------------------------------------------------------------------
create or replace function public._sku_base(p_sku text)
returns text language sql immutable
set search_path = '' as $$
  select regexp_replace(public._sku_norm(p_sku), 'BOGO$', '');
$$;

-- ---------------------------------------------------------------------------
-- 7. adopt_bogo_sku — one-step catalog cleanup for a single twin
-- ---------------------------------------------------------------------------
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

  -- Idempotent: already pointing at this paid SKU → nothing to do.
  if b.delegates_to_child_sku_id = p_paid then return b; end if;

  if b.id = p.id then raise exception 'adopt_bogo_sku: a SKU cannot adopt itself'; end if;
  if b.delegates_to_child_sku_id is not null then
    raise exception 'adopt_bogo_sku: % is already a delegate', p_bogo;
  end if;
  if p.delegates_to_child_sku_id is not null then
    raise exception 'adopt_bogo_sku: paid target % is itself a delegate', p_paid;
  end if;
  if p.site_id <> b.site_id then
    raise exception 'adopt_bogo_sku: SKUs are at different sites';
  end if;
  if coalesce(p.price,0) <= 0 then
    raise exception 'adopt_bogo_sku: paid target % must have a positive price', p_paid;
  end if;

  -- Trapped reserved stock means live orders reserved the BOGO''s own pool;
  -- resolve those by hand before adopting rather than silently moving reserved.
  select * into il from public.inventory_levels where child_sku_id = b.id for update;
  if coalesce(il.reserved,0) > 0 or coalesce(il.layby,0) > 0 then
    raise exception 'adopt_bogo_sku: % has reserved/layby stock — clear its open orders first', p_bogo;
  end if;

  -- Consolidate any on-hand back onto the paid pool (audited, promotes backorders).
  v_move := coalesce(il.on_hand,0);
  if v_move > 0 then
    perform public.adjust_stock(b.id,  -v_move, 'BOGO consolidation → paid (migration 0077)');
    perform public.adjust_stock(p.id,   v_move, 'BOGO consolidation ← ' || coalesce(b.sku,'(no sku)'));
  end if;

  -- Canonical label "<paid>-BOGO" when free; otherwise keep the existing sku
  -- (order mapping is by store_variant_id, not sku, so the label is cosmetic).
  v_label := coalesce(p.sku,'') || '-BOGO';
  if p.sku is null
     or exists (select 1 from public.child_skus o
                 where o.site_id = b.site_id and o.sku = v_label and o.id <> b.id) then
    v_label := b.sku;   -- leave as-is to avoid a (site, sku) collision
  end if;

  -- Single update: re-parent, relabel, zero price, match cost, set the pointer.
  -- The 0076 flag trigger clears suspected_duplicate because delegates_to is set.
  update public.child_skus
     set product_id                = p.product_id,
         sku                       = v_label,
         price                     = 0,
         cost                      = p.cost,
         delegates_to_child_sku_id = p.id
   where id = b.id
   returning * into b;

  -- The paid twin may no longer collide with anything; recompute its flag.
  update public.child_skus
     set suspected_duplicate = public._is_suspected_duplicate(
           p.id, p.site_id, p.sku, p.price, p.cost, p.track_inventory)
   where id = p.id;

  return b;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. auto_adopt_bogo — merge every UNAMBIGUOUS flagged twin, skip the rest
-- ---------------------------------------------------------------------------
create or replace function public.auto_adopt_bogo()
returns integer language plpgsql security definer set search_path = '' as $$
declare b record; v_ids uuid[]; v_n integer := 0;
begin
  if auth.uid() is not null and not public.is_operator() then
    raise exception 'auto_adopt_bogo: admin/manager only';
  end if;

  for b in
    select cs.id, cs.site_id, cs.cost, public._sku_base(cs.sku) as base
      from public.child_skus cs
      join public.inventory_levels il on il.child_sku_id = cs.id
     where cs.suspected_duplicate
       and cs.delegates_to_child_sku_id is null
       and coalesce(cs.track_inventory, true)
       and coalesce(cs.price,0) = 0
       and coalesce(cs.cost,0) > 0
       and coalesce(il.reserved,0) = 0
       and coalesce(il.layby,0) = 0
       and public._sku_base(cs.sku) <> ''
  loop
    -- Deterministic counterpart: same site, same base code, positive price,
    -- equal cost, non-delegate. Adopt only when there is EXACTLY ONE.
    select array_agg(o.id) into v_ids
      from public.child_skus o
     where o.site_id = b.site_id
       and o.id <> b.id
       and o.is_active
       and o.delegates_to_child_sku_id is null
       and coalesce(o.price,0) > 0
       and o.cost = b.cost
       and public._sku_norm(o.sku) = b.base;

    if array_length(v_ids, 1) = 1 then
      perform public.adopt_bogo_sku(b.id, v_ids[1]);
      v_n := v_n + 1;
    end if;   -- 0 or >1 candidates: leave flagged for manual review
  end loop;

  return v_n;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Review queue: flagged twins not yet adopted (ambiguous / needs a human)
-- ---------------------------------------------------------------------------
create or replace view public.bogo_review_queue
  with (security_invoker = true) as
select * from public.suspected_duplicate_skus
 where id not in (
   select id from public.child_skus where delegates_to_child_sku_id is not null);

comment on view public.bogo_review_queue is
  'Flagged BOGO/duplicate SKUs that auto_adopt_bogo could NOT merge (no single '
  'unambiguous paid counterpart). Resolve each with adopt_bogo_sku(bogo, paid).';

grant select  on public.bogo_review_queue to authenticated;
grant execute on function public._stock_sku(uuid)            to authenticated;
grant execute on function public.adopt_bogo_sku(uuid, uuid)  to authenticated;
grant execute on function public.auto_adopt_bogo()           to authenticated;

commit;
