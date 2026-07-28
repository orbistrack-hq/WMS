-- ============================================================================
-- WMS — Migration 0084: store stock seeds on create only, never re-applies
--
-- PROBLEM (measured in prod 2026-07-27)
--   upsert_store_variant pushed the store's inventory count into WMS on_hand on
--   EVERY product sync, through set_on_hand_to. That function clamps with
--   greatest(target, reserved, 0), so any store number below the WMS number
--   REDUCES on_hand. It has no lower guard beyond reserved.
--
--   WooCommerce's count sits under WMS's, so every sync ratcheted WMS down and
--   nothing ever lifted it back. On Blue Slushie alone, all 15 Woo sync rows are
--   negative — not one increase — totalling exactly -539 g excluding the BOGO
--   twin, which is the entire physical-vs-WMS shortfall fulfillment reported.
--
--   The double-subtraction: a store order ALREADY decrements stock through
--   order_consume when it is fulfilled. Re-applying the store's post-sale count
--   on the next product sync subtracts the same sales a second time.
--
--   (Shopify by contrast nets ~zero here: it added stock on 07-06/07-09 and a
--   07-10 sync reverted each SKU by the identical amount. Symmetric churn, not a
--   drain. The bug is the mechanism, not one platform.)
--
-- DECISION (confirmed with J 2026-07-27): store stock SEEDS, WMS OWNS.
--   Apply the store count only when this sync CREATES the child SKU. After that
--   WMS is authoritative and no store number may move on_hand again.
--
--   This mirrors the cost policy already living in this same function — cost
--   seeds on create and is never clobbered by a resync — so the whole function
--   now follows one rule instead of two.
--
--   Rejected: clamping inbound to increase-only. It still lets an inflated store
--   count invent stock, and leaves two different rules for cost and quantity.
--   Rejected: dropping the apply entirely. New SKUs would land at on_hand 0 and
--   read as out of stock until someone received them by hand.
--
-- WHAT THIS DOES NOT DO
--   * set_on_hand_to survives untouched and stays callable for deliberate
--     reconciliation (tests 09 and 18 exercise it directly).
--   * The 0026 loop-suppression trigger keys off reason 'shopify_sync'; it
--     simply sees fewer rows. Outbound publish is unaffected.
--   * Stock already written off is NOT restored. That needs a physical count and
--     an adjust_stock with a note — deliberately manual, so it lands in the
--     ledger with a human reason.
--
-- NOTE: recreated verbatim from migration 0068 apart from the `and v_created`
-- guard on the stock apply. SECURITY INVOKER is preserved deliberately: catalog
-- sync calls this with the service-role client and the RETURNING contract
-- depends on invoker rights.
--
-- Reverse with rollback/20260727000084_store_stock_seed_on_create_only.down.sql.
-- ============================================================================

begin;

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

  -- ---- 0084: SEED ONLY -----------------------------------------------------
  -- Take the store's count only when this call created the child SKU. On every
  -- later sync WMS owns on_hand and the store number is ignored, which is what
  -- stops the one-way ratchet described in this migration's header.
  --
  -- v_created is false on the 2a "adopt an existing SKU" path by design: that
  -- child already carries a WMS-owned balance and must not be overwritten by
  -- whatever the store happens to think.
  --
  -- Still skipped for non-inventory children — a fee line's store "stock" is
  -- fictional (migration 0068).
  if p_inventory_qty is not null
     and v_created
     and exists (select 1 from public.child_skus
                  where id = v_child and track_inventory) then
    perform public.set_on_hand_to(
      v_child, p_inventory_qty, p_channel, null,
      format('Opening stock seeded from %s on first sync', initcap(coalesce(p_channel, 'store'))));
  end if;

  return query select v_child, v_created, v_seeded;
end;
$$;

comment on function public.upsert_store_variant(uuid,text,text,text,numeric,numeric,integer,text) is
  'Idempotent store-variant upsert. Cost AND stock both seed on create only and are never re-applied by a later sync — WMS owns both once set (migration 0084). Non-inventory/fee children never take store stock. SECURITY INVOKER: catalog sync calls this with the service-role client.';

commit;
