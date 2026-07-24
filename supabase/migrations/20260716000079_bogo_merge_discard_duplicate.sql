-- ============================================================================
-- WMS — Migration 0079: BOGO merge discards the duplicate count by default
--
-- Reality on the floor: for a long time the fulfillment team kept a separate
-- stock number for the BOGO SKU and the real SKU, but those are the SAME
-- physical jars counted twice (the free jars come off the same shelf). So the
-- 0077 merge behaviour — MOVE the BOGO's on-hand onto the paid pool (add) —
-- would DOUBLE the real inventory at merge time.
--
-- Fix: adopt_bogo_sku gains an explicit stock mode, defaulting to 'discard':
--   * 'discard' (default) — same jars, double-tracked: drop the BOGO's count,
--     keep the paid pool's number as the single truth. NEVER sums.
--   * 'move'   — genuinely separate piles: add the BOGO's on-hand to the paid
--     pool (the old 0077 behaviour), for the rare segregated case.
--   * 'set'    — reconcile: set the paid pool to a fresh physical count and drop
--     the BOGO's, for when the two numbers have drifted apart.
-- auto_adopt_bogo() calls the 2-arg form, so it now inherits 'discard' and can
-- never double-count an auto-merge.
--
-- Reverse with rollback/20260716000079_bogo_merge_discard_duplicate.down.sql.
-- ============================================================================

begin;

drop function if exists public.adopt_bogo_sku(uuid, uuid);

create or replace function public.adopt_bogo_sku(
  p_bogo uuid, p_paid uuid,
  p_stock_mode text default 'discard',   -- 'discard' | 'move' | 'set'
  p_counted integer default null
) returns public.child_skus
language plpgsql security definer set search_path = '' as $$
declare b public.child_skus; p public.child_skus;
        il public.inventory_levels; pil public.inventory_levels;
        v_label text; v_move integer; v_delta integer;
begin
  if auth.uid() is not null and not public.is_operator() then
    raise exception 'adopt_bogo_sku: admin/manager only';
  end if;
  if p_stock_mode not in ('discard','move','set') then
    raise exception 'adopt_bogo_sku: invalid stock mode %', p_stock_mode;
  end if;

  select * into b from public.child_skus where id = p_bogo for update;
  if not found then raise exception 'adopt_bogo_sku: BOGO SKU % not found', p_bogo; end if;
  select * into p from public.child_skus where id = p_paid for update;
  if not found then raise exception 'adopt_bogo_sku: paid SKU % not found', p_paid; end if;

  if b.delegates_to_child_sku_id = p_paid then return b; end if;   -- idempotent
  if b.id = p.id then raise exception 'adopt_bogo_sku: a SKU cannot adopt itself'; end if;
  if b.delegates_to_child_sku_id is not null then
    raise exception 'adopt_bogo_sku: % is already a delegate', p_bogo; end if;
  if p.delegates_to_child_sku_id is not null then
    raise exception 'adopt_bogo_sku: paid target % is itself a delegate', p_paid; end if;
  if p.site_id <> b.site_id then
    raise exception 'adopt_bogo_sku: SKUs are at different sites'; end if;
  if coalesce(p.price,0) <= 0 then
    raise exception 'adopt_bogo_sku: paid target % must have a positive price', p_paid; end if;

  select * into il from public.inventory_levels where child_sku_id = b.id for update;
  if coalesce(il.reserved,0) > 0 or coalesce(il.layby,0) > 0 then
    raise exception 'adopt_bogo_sku: % has reserved/layby stock — clear its open orders first', p_bogo;
  end if;

  if p_stock_mode = 'discard' then
    -- Same jars, double-tracked: the BOGO number is a duplicate of the paid
    -- pool. Drop it; the paid pool stays the single source of truth.
    if coalesce(il.on_hand,0) <> 0 then
      perform public.adjust_stock(b.id, -il.on_hand,
        'BOGO merge: same jars, discard duplicate count (migration 0079)');
    end if;
  elsif p_stock_mode = 'move' then
    -- Genuinely separate pile: add the BOGO's on-hand to the paid pool.
    v_move := coalesce(il.on_hand,0);
    if v_move > 0 then
      perform public.adjust_stock(b.id, -v_move, 'BOGO merge: move separate pile → paid');
      perform public.adjust_stock(p.id,  v_move, 'BOGO merge: separate pile ← ' || coalesce(b.sku,'(no sku)'));
    end if;
  else  -- 'set': reconcile paid to a fresh physical count, drop the BOGO's.
    if p_counted is null then
      raise exception 'adopt_bogo_sku: stock mode ''set'' requires a counted quantity';
    end if;
    if coalesce(il.on_hand,0) <> 0 then
      perform public.adjust_stock(b.id, -il.on_hand,
        'BOGO merge: discard duplicate count (reconciled to physical)');
    end if;
    select * into pil from public.inventory_levels where child_sku_id = p.id for update;
    v_delta := p_counted - coalesce(pil.on_hand,0);
    if v_delta <> 0 then
      perform public.adjust_stock(p.id, v_delta,
        'BOGO merge: reconcile paid to counted ' || p_counted);
    end if;
  end if;

  -- Canonical label "<paid>-BOGO" when free; else keep the existing sku
  -- (order mapping is by store_variant_id, so the label is cosmetic).
  v_label := coalesce(p.sku,'') || '-BOGO';
  if p.sku is null
     or exists (select 1 from public.child_skus o
                 where o.site_id = b.site_id and o.sku = v_label and o.id <> b.id) then
    v_label := b.sku;
  end if;

  update public.child_skus
     set product_id                = p.product_id,
         sku                       = v_label,
         price                     = 0,
         cost                      = p.cost,
         delegates_to_child_sku_id = p.id
   where id = b.id
   returning * into b;

  update public.child_skus
     set suspected_duplicate = public._is_suspected_duplicate(
           p.id, p.site_id, p.sku, p.price, p.cost, p.track_inventory)
   where id = p.id;

  return b;
end;
$$;

grant execute on function public.adopt_bogo_sku(uuid, uuid, text, integer) to authenticated;

commit;
