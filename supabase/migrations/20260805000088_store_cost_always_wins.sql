-- ============================================================================
-- WMS — Migration 0088: the store OWNS cost; every sync overwrites it
--
-- PROBLEM (reported by J 2026-08-05)
--   Editing a product's cost in Shopify or WooCommerce did not move the child
--   SKU's cost in WMS. That was not a break — it was the rule. Both upsert RPCs
--   carried a seed-only guard:
--
--     v_seeded := (p_cost is not null and coalesce(v_cost, 0) = 0);
--     ... cost = case when v_seeded then p_cost else cost end
--
--   i.e. the store's cost landed only while the child's cost was still 0 or
--   null. Once a child had a real cost, WMS owned it forever and every later
--   sync silently discarded the store number. Price, on the same call, was
--   overwritten every time — so cost and price followed opposite rules, which
--   is what made this read as a bug.
--
-- DECISION (confirmed with J 2026-08-05): cost lives in the store, WMS mirrors.
--   A store cost now overwrites child_skus.cost on EVERY sync, matching how
--   price already behaves. One rule for both money fields.
--
--   Rejected: a per-connection "store owns cost" toggle. More surface, and the
--   answer is the same for every store we run.
--   Rejected: tracking manual cost edits and deferring to them. Correct, but it
--   needs an edited-in-WMS flag on child_skus and a writer audit; not worth the
--   schema churn while the store is the system of record for cost anyway.
--
-- THE ONE GUARD WE KEEP: p_cost > 0
--   Overwrite fires only for a POSITIVE store cost. A null cost already meant
--   "the store sent nothing" (Woo core has no cost field at all — lib/woocommerce
--   /types.ts reads Cost-of-Goods plugin meta and returns null when absent), and
--   a zero cost is indistinguishable from an unfilled field on both platforms.
--   Without this guard, one sync of a catalog whose COG plugin reports 0 would
--   zero out every cost in WMS and take inventory valuation and the COGS basis
--   with it.
--
--   It also protects two known zero/near-zero cases:
--     * BOGO give-away children, whose cost is deliberately matched to the paid
--       counterpart by adopt_bogo_sku (0077) and reads as free in the store.
--     * Non-inventory fee SKUs like Route "Shipping Protection" (0068).
--
--   To let a store push a literal 0 cost, drop `and p_cost > 0` from both
--   assignments below — but expect the mass-zeroing failure mode above.
--
-- WHAT THIS DOES NOT DO
--   * Does not touch the stock rule. Store stock still SEEDS on create only
--     (0084 / 0085); that ratchet fix stands and is unrelated.
--   * Does not backfill. Costs already diverged from the store stay as they are
--     until the next sync of that variant touches them. Run a full catalog sync
--     from /integrations to pull every current cost forward in one pass.
--   * Does not rewrite history. order_line_items.unit_cost_snapshot is frozen at
--     fulfillment (0019), so past margin and COGS reporting is unaffected. Only
--     forward-looking valuation moves.
--
-- The `cost_seeded` return column keeps its name — lib/{shopify,woocommerce}
-- /import-products.ts read it — but now means "cost written from the store on
-- this call" rather than "seeded because it was empty".
--
-- Both functions are recreated verbatim from 0084 and 0085 apart from the cost
-- assignments. SECURITY INVOKER is preserved deliberately: catalog sync calls
-- these with the service-role client and the RETURNING contract depends on
-- invoker rights.
--
-- Reverse with rollback/20260805000088_store_cost_always_wins.down.sql.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Non-weighted path (Shopify simple variants, Woo simple products)
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
    -- 0088: a positive store cost now wins on every sync, not just the first.
    v_seeded := (p_cost is not null and p_cost > 0);
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
      v_seeded := (p_cost is not null and p_cost > 0);
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
        v_seeded := (p_cost is not null and p_cost > 0);
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
        v_seeded := (p_cost is not null and p_cost > 0);
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
    v_seeded := (p_cost is not null and p_cost > 0);
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

  -- ---- 0084: stock SEEDS ONLY (unchanged by 0088) ---------------------------
  -- Take the store's count only when this call created the child SKU. On every
  -- later sync WMS owns on_hand and the store number is ignored, which is what
  -- stops the one-way ratchet described in migration 0084.
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
  'Idempotent store-variant upsert. COST: the store owns it — any positive p_cost overwrites child_skus.cost on every sync (migration 0088); a null or zero cost is treated as "store sent nothing" and leaves the WMS value alone. STOCK: still seeds on create only, WMS owns it after that (migration 0084). Non-inventory/fee children never take store stock. The cost_seeded return flag means "cost written from the store on this call". SECURITY INVOKER: catalog sync calls this with the service-role client.';

-- ---------------------------------------------------------------------------
-- 2. Weight-variant path (3.5g / 7g / 14g / 28g — most of the catalog)
-- ---------------------------------------------------------------------------
create or replace function public.upsert_store_weight_variant(
  p_site_id          uuid,
  p_store_variant_id text,
  p_strain_name      text,       -- the parent strain (store product title)
  p_grams_per_unit   numeric,    -- parsed weight, must be > 0
  p_sku              text default null,
  p_price            numeric default 0,
  p_cost             numeric default null,
  p_inventory_qty    integer default null,
  p_channel          text default 'manual'
) returns table(child_sku_id uuid, created boolean, cost_seeded boolean)
language plpgsql as $$
declare
  v_child   uuid;
  v_product uuid;
  v_cost    numeric;
  v_sku     text    := nullif(btrim(coalesce(p_sku, '')), '');
  v_price   numeric := coalesce(p_price, 0);
  v_name    text    := nullif(btrim(coalesce(p_strain_name, '')), '');
  v_created boolean := false;
  v_seeded  boolean := false;
  v_label   text;
begin
  if p_site_id is null
     or nullif(btrim(coalesce(p_store_variant_id, '')), '') is null then
    raise exception 'upsert_store_weight_variant: site and store_variant_id are required';
  end if;
  if p_grams_per_unit is null or p_grams_per_unit <= 0 then
    raise exception 'upsert_store_weight_variant: grams_per_unit must be positive';
  end if;
  if v_name is null then
    raise exception 'upsert_store_weight_variant: strain name is required';
  end if;

  -- Label like "3.5g" / "28g" (strip trailing zeros).
  v_label := rtrim(rtrim(p_grams_per_unit::text, '0'), '.') || 'g';

  -- 1. Same variant already mapped at this site -> update in place (idempotent).
  select cs.id, cs.product_id, cs.cost into v_child, v_product, v_cost
    from public.child_skus cs
   where cs.site_id = p_site_id and cs.store_variant_id = p_store_variant_id
   limit 1;

  if v_child is not null then
    -- 0088: a positive store cost now wins on every sync, not just the first.
    v_seeded := (p_cost is not null and p_cost > 0);
    begin
      update public.child_skus
         set sku = v_sku, price = v_price, is_active = true,
             grams_per_unit = p_grams_per_unit,
             variant_label  = coalesce(variant_label, v_label),
             cost = case when v_seeded then p_cost else cost end
       where id = v_child;
    exception when unique_violation then
      -- SKU collides with another child at this site; keep the mapping, drop sku.
      update public.child_skus
         set sku = null, price = v_price, is_active = true,
             grams_per_unit = p_grams_per_unit,
             variant_label  = coalesce(variant_label, v_label),
             cost = case when v_seeded then p_cost else cost end
       where id = v_child;
    end;
    update public.products set name = v_name, is_active = true where id = v_product;
    v_created := false;
  else

  -- 2. Resolve the shared strain parent: an existing product with this exact
  --    name that already holds a weight child (any site). Else create it.
  select p.id into v_product
    from public.products p
   where p.name = v_name
     and exists (
       select 1 from public.child_skus c
        where c.product_id = p.id and c.grams_per_unit is not null)
   order by p.created_at
   limit 1;
  if v_product is null then
    insert into public.products(name) values (v_name) returning id into v_product;
  end if;

  v_seeded := (p_cost is not null and p_cost > 0);

  -- 3. Adopt an UNMAPPED child at this (product, site, weight) ONLY on an exact
  --    SKU match — otherwise insert a fresh child. Two same-weight children can
  --    now coexist (0057), so weight alone is no longer a unique key; adopting on
  --    weight could stamp this store variant onto a manual "ounce special". A new
  --    variant with no sku twin therefore creates its own child (visible and
  --    mergeable) rather than silently taking over an existing one.
  v_child := null;
  if v_sku is not null then
    select cs.id into v_child
      from public.child_skus cs
     where cs.product_id = v_product and cs.site_id = p_site_id
       and cs.grams_per_unit = p_grams_per_unit
       and cs.store_variant_id is null
       and cs.sku = v_sku
     limit 1;
  end if;

  if v_child is not null then
    begin
      update public.child_skus
         set store_variant_id = p_store_variant_id, sku = v_sku, price = v_price,
             is_active = true, variant_label = coalesce(variant_label, v_label),
             cost = case when v_seeded then p_cost else cost end
       where id = v_child;
    exception when unique_violation then
      update public.child_skus
         set store_variant_id = p_store_variant_id, sku = null, price = v_price,
             is_active = true, variant_label = coalesce(variant_label, v_label),
             cost = case when v_seeded then p_cost else cost end
       where id = v_child;
    end;
    v_created := false;
  else
    begin
      insert into public.child_skus
        (product_id, site_id, sku, store_variant_id, grams_per_unit, variant_label, price, cost)
      values
        (v_product, p_site_id, v_sku, p_store_variant_id, p_grams_per_unit, v_label,
         v_price, coalesce(p_cost, 0))
      returning id into v_child;
    exception when unique_violation then
      -- SKU collision at this site -> insert without the sku code.
      insert into public.child_skus
        (product_id, site_id, sku, store_variant_id, grams_per_unit, variant_label, price, cost)
      values
        (v_product, p_site_id, null, p_store_variant_id, p_grams_per_unit, v_label,
         v_price, coalesce(p_cost, 0))
      returning id into v_child;
    end;
    v_created := true;
  end if;
  end if;

  -- ---- 0085: stock SEEDS ONLY (unchanged by 0088) ---------------------------
  -- Take the store's count only when this call CREATED the child SKU. On every
  -- later sync WMS owns on_hand and the store number is ignored.
  --
  -- Also skip non-inventory children, matching the guard migration 0068 added to
  -- upsert_store_variant.
  if p_inventory_qty is not null
     and v_created
     and exists (select 1 from public.child_skus
                  where id = v_child and track_inventory) then
    perform public.set_on_hand_to(
      v_child, p_inventory_qty, p_channel, null,
      format('Opening stock seeded from %s on first sync',
             initcap(coalesce(p_channel, 'store'))));
  end if;

  return query select v_child, v_created, v_seeded;
end;
$$;

comment on function public.upsert_store_weight_variant(uuid,text,text,numeric,text,numeric,numeric,integer,text) is
  'Idempotent weight-variant upsert (3.5g/7g/14g/28g). COST: the store owns it — any positive p_cost overwrites child_skus.cost on every sync (migration 0088); null or zero leaves the WMS value alone. STOCK: seeds on create only (migration 0085). SECURITY INVOKER: catalog sync calls this with the service-role client.';

commit;
