-- ============================================================================
-- WMS — Migration 0078: detect BOGO by the explicit "-BOGO" SKU suffix
--
-- The storefront's BOGO implementation keeps the free variant's CATALOG price
-- equal to the paid product and zeroes the price only on the ORDER LINE. So the
-- price-0 give-away fingerprint (migrations 0076/0077) never fires for these —
-- their catalog price stays at retail (e.g. BC-BS-3.5G-BOGO shows $80). Revenue
-- is still correct (WMS books the order line's zeroed price, not catalog price),
-- but detection and auto-merge, which keyed on catalog price = 0, miss them.
--
-- Fix: make the "-BOGO" SKU suffix a first-class signal, independent of catalog
-- price. A child whose normalized SKU ends in BOGO (with a non-empty base) is a
-- BOGO by naming convention. This flags them for review and lets auto_adopt_bogo
-- merge them against their single base-matched, equal-cost paid counterpart.
--
-- Reverse with rollback/20260716000078_bogo_suffix_detection.down.sql.
-- ============================================================================

begin;

-- ---- 1. Detection gains a "-BOGO" suffix fingerprint ------------------------
create or replace function public._is_suspected_duplicate(
  p_id uuid, p_site_id uuid, p_sku text, p_price numeric, p_cost numeric,
  p_track_inventory boolean
) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare v_norm text := public._sku_norm(p_sku);
begin
  -- Fingerprint 0: explicit "-BOGO" SKU suffix (naming convention).
  if v_norm ~ 'BOGO$' and public._sku_base(p_sku) <> '' then
    return true;
  end if;
  -- Fingerprint 1: give-away — free to the customer but it costs us.
  if coalesce(p_track_inventory, true)
     and coalesce(p_price, 0) = 0
     and coalesce(p_cost, 0) > 0 then
    return true;
  end if;
  -- Fingerprint 2: normalized-SKU collision with another coded child, same site.
  if v_norm <> '' and exists (
    select 1 from public.child_skus o
     where o.site_id = p_site_id
       and o.id <> p_id
       and o.sku is not null and o.sku <> ''
       and public._sku_norm(o.sku) = v_norm
  ) then
    return true;
  end if;
  return false;
end;
$$;

-- ---- 2. Re-flag existing non-delegate children under the new rule -----------
update public.child_skus cs
   set suspected_duplicate = public._is_suspected_duplicate(
         cs.id, cs.site_id, cs.sku, cs.price, cs.cost, cs.track_inventory)
 where cs.delegates_to_child_sku_id is null;

-- ---- 3. auto_adopt_bogo: merge "-BOGO" suffixes too, not just price-0 twins --
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
       and coalesce(cs.track_inventory, true)
       and coalesce(il.reserved,0) = 0
       and coalesce(il.layby,0) = 0
       and public._sku_base(cs.sku) <> ''
       and (
         public._sku_norm(cs.sku) ~ 'BOGO$'                                        -- explicit suffix
         or (cs.suspected_duplicate and coalesce(cs.price,0) = 0 and coalesce(cs.cost,0) > 0)  -- unlabeled twin
       )
  loop
    -- Deterministic counterpart: same site, base code == this SKU's base,
    -- positive price, equal cost, non-delegate. Adopt only when EXACTLY ONE.
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

commit;
