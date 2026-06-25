-- ============================================================================
-- WMS — Migration 0017: Shopify cost + inventory backfill
--
-- Extends the Shopify product sync (migration 0014) so the backfill also pulls
-- two more facts into the relevant pages:
--
--   * cost      — seeded from Shopify's InventoryItem.cost, but ONLY when WMS
--                 has no cost yet (cost is null/0). A cost an operator entered
--                 by hand is never clobbered. This is a deliberate, narrow
--                 relaxation of migration 0014's "WMS owns cost" rule: Shopify
--                 may seed an empty cost, WMS still wins on anything set.
--   * on_hand   — set to match Shopify's available quantity, recorded as an
--                 inventory_ledger movement (reason 'shopify_sync') so the
--                 change is auditable like every other stock move. WMS
--                 reservations are preserved: on_hand is never driven below the
--                 reserved count (stock already committed to a WMS order), so
--                 the oversell guard (on_hand >= reserved) can't be violated.
--
-- Conflict policy after this migration:
--   name / price / sku   -> Shopify wins (unchanged)
--   on_hand              -> Shopify wins on sync, clamped to reserved, logged
--   cost                 -> WMS wins; Shopify only seeds when WMS has none
--   reserved / available -> owned entirely by the WMS reservation state machine
--
-- Scope: backfill only (the "Sync products" button). Product webhooks keep the
-- old behaviour — they pass neither cost nor quantity, so this is inert there.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. New ledger reason for inventory changes that originate from a store sync.
--    Keeps these distinct from manual_adjustment / receipt in reporting.
-- ----------------------------------------------------------------------------
alter table public.inventory_ledger drop constraint inventory_ledger_reason_check;
alter table public.inventory_ledger add constraint inventory_ledger_reason_check
  check (reason in (
    'order_reserve','order_release','order_consume',
    'layaway_remove','layaway_cancel','layaway_consume',
    'manual_adjustment','receipt','correction','shopify_sync'));

-- ----------------------------------------------------------------------------
-- 2. set_on_hand_to: drive on_hand to an absolute target, the safe way.
--
--    Unlike adjust_stock (a signed delta), a sync knows the *target* count, not
--    the delta. This computes the delta for us, clamps the target up to the
--    reserved floor so committed stock is never lost, and writes through the
--    same locked-row + ledger primitive every other inventory move uses. A
--    re-sync with an unchanged target is a no-op (no ledger noise) — idempotent.
--
--    SECURITY DEFINER + sealed search_path, matching the other inventory
--    transition functions (migration 0003), since direct writes to
--    inventory_levels / inventory_ledger are revoked from the API role.
-- ----------------------------------------------------------------------------
create or replace function public.set_on_hand_to(
  p_child_sku_id uuid,
  p_target       integer,
  p_ref_type     text default 'shopify',
  p_ref_id       uuid default null,
  p_note         text default null
) returns public.inventory_levels
language plpgsql security definer set search_path = '' as $$
declare
  v        public.inventory_levels;
  v_target integer;
  v_delta  integer;
begin
  if p_target is null then
    raise exception 'set_on_hand_to: target quantity is required';
  end if;

  v := public._inv_lock(p_child_sku_id);

  -- Never drop on_hand below stock already reserved to WMS orders.
  v_target := greatest(p_target, v.reserved, 0);
  v_delta  := v_target - v.on_hand;

  if v_delta = 0 then
    return v;  -- nothing to change; keep the ledger clean on repeat syncs
  end if;

  return public._inv_write(
    p_child_sku_id, v_delta, 0, 0,
    'shopify_sync', p_ref_type, p_ref_id,
    coalesce(p_note, 'Inventory synced from Shopify'));
end;
$$;

comment on function public.set_on_hand_to is
  'Set on_hand to an absolute target (e.g. from a store sync), clamped up to the reserved floor, recorded in the inventory ledger as reason shopify_sync. Idempotent when the target is unchanged.';

grant execute on function
  public.set_on_hand_to(uuid,integer,text,uuid,text) to authenticated;

-- ----------------------------------------------------------------------------
-- 3. Extend upsert_shopify_variant with optional cost (seed-only) + quantity.
--    Old 5-arg callers (product webhooks) keep working: the new args default to
--    null, which means "leave cost and on_hand untouched". Drop the prior
--    signature first so the 5-arg call isn't ambiguous against the new defaults.
-- ----------------------------------------------------------------------------
drop function if exists public.upsert_shopify_variant(uuid,text,text,text,numeric);

create or replace function public.upsert_shopify_variant(
  p_site_id          uuid,
  p_store_variant_id text,
  p_name             text,
  p_sku              text default null,
  p_price            numeric default 0,
  p_cost             numeric default null,
  p_inventory_qty    integer default null
) returns table(child_sku_id uuid, created boolean, cost_seeded boolean)
language plpgsql as $$
declare
  v_child   uuid;
  v_product uuid;
  v_cost    numeric;
  v_sku     text := nullif(btrim(coalesce(p_sku, '')), '');
  v_price   numeric := coalesce(p_price, 0);
  v_created boolean;
  v_seeded  boolean := false;
begin
  if p_site_id is null or nullif(btrim(coalesce(p_store_variant_id,'')),'') is null then
    raise exception 'upsert_shopify_variant: site and store_variant_id are required';
  end if;

  select cs.id, cs.product_id, cs.cost into v_child, v_product, v_cost
    from public.child_skus cs
   where cs.site_id = p_site_id and cs.store_variant_id = p_store_variant_id
   limit 1;

  if v_child is not null then
    -- Seed cost only when WMS has none; never clobber a manual cost.
    v_seeded := (p_cost is not null and coalesce(v_cost, 0) = 0);
    -- Update price/sku/name; preserve cost unless seeding. If the sku collides
    -- with another SKU at this site, keep the variant but drop the sku.
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
  else
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

  -- Pull Shopify stock into WMS on_hand (logged; reservations preserved).
  if p_inventory_qty is not null then
    perform public.set_on_hand_to(
      v_child, p_inventory_qty, 'shopify', null,
      'Inventory synced from Shopify');
  end if;

  return query select v_child, v_created, v_seeded;
end;
$$;

comment on function public.upsert_shopify_variant is
  'Idempotently map one Shopify variant to a WMS product + child SKU (keyed by store_variant_id). Shopify owns name/price/sku; cost is seeded only when WMS has none; on_hand, when provided, is synced via set_on_hand_to.';

grant execute on function
  public.upsert_shopify_variant(uuid,text,text,text,numeric,numeric,integer)
  to authenticated;

commit;
