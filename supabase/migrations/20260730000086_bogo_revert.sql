-- ============================================================================
-- WMS — Migration 0080: revert a BOGO merge (back to two separate stock numbers)
--
-- Undo a shared-stock merge for one product: the BOGO SKU stops delegating and
-- goes back to holding its own independent stock number, exactly as before.
--
-- Two hazards this handles that a manual `delegates_to = null` would not:
--   1. Stranded reservations — while merged, open orders with a BOGO line hold
--      their reservation on the PAID pool. Un-merging underneath them would leave
--      the BOGO pool with 0 reserved, so fulfilling those orders would fail. So
--      revert BLOCKS if the SKU has open orders holding reserved stock.
--   2. Re-merge loop — a reverted "-BOGO" SKU still matches auto_adopt_bogo and
--      would be merged again on the next sync. So revert sets a
--      bogo_merge_opt_out flag that auto_adopt (and the flag trigger) respect.
--
-- Reverse with rollback/20260716000080_bogo_revert.down.sql.
-- ============================================================================

begin;

-- ---- 1. Opt-out flag --------------------------------------------------------
alter table public.child_skus
  add column if not exists bogo_merge_opt_out boolean not null default false;

comment on column public.child_skus.bogo_merge_opt_out is
  'When true, this SKU is deliberately kept OUT of BOGO shared-stock merging '
  '(auto_adopt_bogo skips it and it is not flagged as a suspected duplicate). '
  'Set by revert_bogo_sku so a manually un-merged SKU is not re-merged on sync.';

-- ---- 2. Flag trigger also leaves opted-out SKUs alone -----------------------
create or replace function public.flag_suspected_duplicate()
returns trigger language plpgsql
security definer set search_path = '' as $$
begin
  if new.delegates_to_child_sku_id is not null or new.bogo_merge_opt_out then
    new.suspected_duplicate := false;
    return new;
  end if;
  new.suspected_duplicate := public._is_suspected_duplicate(
    new.id, new.site_id, new.sku, new.price, new.cost, new.track_inventory);
  return new;
end;
$$;

-- ---- 3. auto_adopt_bogo skips opted-out SKUs --------------------------------
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
     where cs.delegates_to_child_sku_id is null
       and not cs.bogo_merge_opt_out
       and coalesce(cs.track_inventory, true)
       and coalesce(il.reserved,0) = 0
       and coalesce(il.layby,0) = 0
       and public._sku_base(cs.sku) <> ''
       and (
         public._sku_norm(cs.sku) ~ 'BOGO$'
         or (cs.suspected_duplicate and coalesce(cs.price,0) = 0 and coalesce(cs.cost,0) > 0)
       )
  loop
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
    end if;
  end loop;

  return v_n;
end;
$$;

-- ---- 4. revert_bogo_sku -----------------------------------------------------
create or replace function public.revert_bogo_sku(
  p_bogo uuid,
  p_restore_on_hand integer default null,   -- give the SKU its own stock number
  p_restore_sku     text    default null,   -- optionally rename it back
  p_opt_out         boolean default true     -- keep it out of future auto-merge
) returns public.child_skus
language plpgsql security definer set search_path = '' as $$
declare b public.child_skus;
begin
  if auth.uid() is not null and not public.is_operator() then
    raise exception 'revert_bogo_sku: admin/manager only';
  end if;

  select * into b from public.child_skus where id = p_bogo for update;
  if not found then raise exception 'revert_bogo_sku: SKU % not found', p_bogo; end if;
  if b.delegates_to_child_sku_id is null then
    raise exception 'revert_bogo_sku: % is not merged (nothing to revert)', p_bogo;
  end if;

  -- Hazard 1: reservations for this SKU currently live on the paid pool.
  if exists (
    select 1 from public.order_line_items oli
      join public.orders o on o.id = oli.order_id
     where oli.child_sku_id = p_bogo
       and o.status not in ('fulfilled','cancelled')
       and (oli.quantity - coalesce(oli.backordered_qty,0)) > 0
  ) then
    raise exception 'revert_bogo_sku: % has open orders holding reserved stock on the paid pool — fulfill or cancel them first', p_bogo
      using errcode = 'check_violation';
  end if;

  -- Optional rename back (skip on (site, sku) collision).
  if p_restore_sku is not null
     and not exists (select 1 from public.child_skus o
                      where o.site_id = b.site_id and o.sku = p_restore_sku and o.id <> b.id) then
    update public.child_skus set sku = p_restore_sku where id = b.id;
  end if;

  -- Detach: the SKU holds its own pool again (currently 0), and opt out of
  -- re-merge. delegates_to is not in the flag trigger's column list, so set the
  -- flag explicitly here.
  update public.child_skus
     set delegates_to_child_sku_id = null,
         bogo_merge_opt_out        = p_opt_out,
         suspected_duplicate       = false
   where id = b.id
   returning * into b;

  -- Give it back its own stock number (paid pool is left untouched).
  if coalesce(p_restore_on_hand, 0) > 0 then
    perform public.receive_stock(p_bogo, p_restore_on_hand, 'correction', null,
      'BOGO merge reverted — restored independent stock');
  end if;

  return b;
end;
$$;

grant execute on function public.revert_bogo_sku(uuid, integer, text, boolean) to authenticated;

commit;
