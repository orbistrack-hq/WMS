-- ============================================================================
-- WMS — Migration 0109: store sync no longer renames existing products
--
-- PROBLEM (reported by J 2026-09-14)
--   After "Sync products" on Bud Club, the catalog showed 29 products all
--   named "2G BARE CARTS (LIVE RESIN)", 29 "BARE 2G DISPOSABLES VAPES", 16 each
--   of BARE ROSIN / CRUMBLE / BADDER, and so on. Nothing was duplicated: those
--   were existing one-per-flavor products ("2G BARE CARTS (LIVE RESIN) -
--   azul-runtz") that the sync RENAMED to the store's parent title.
--
--   Two faults combined:
--
--   1. THE PARSER. Flavor attributes don't parse as a weight, so the Woo
--      importer fell back to SKU codes ending in "2G"/"1G" and sent each
--      flavor down the weight-variant path with the parent title as the
--      strain name. Fixed in lib/catalog/weight.ts (wooVariationGrams).
--
--   2. THIS ONE. Both upsert RPCs overwrite products.name on every sync of an
--      already-mapped variant (upsert_store_weight_variant with the strain
--      name, upsert_store_variant with the variant name). A WMS product is
--      routinely NOT one store listing: it holds merged children, several
--      weights, and children from other sites. Whichever variant synced last
--      named it — the same sync also turned "Tropical Runtz - Hybrid - 3.5G"
--      into "Tropical Runtz - Hybrid", colliding with the product the new
--      bulk variations had just created, and a later webhook named Midnight
--      Crasher's product after its 1/4 LB variation.
--
-- DECISION: the store names a product when the sync CREATES it; after that
--   the name belongs to WMS, the same rule 0108 applied to weight. Renames on
--   the store no longer reach an existing WMS product; rename it in Catalog.
--   The step-1 update still reactivates the product (is_active = true).
--
-- Only the rename line changes in each function; the bodies are otherwise
-- 0088 (upsert_store_variant) and 0108 (upsert_store_weight_variant) verbatim.
--
-- Reverse with rollback/20260914000109_store_sync_keeps_product_names.down.sql.
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
    -- 0109: the store no longer renames an existing product; WMS owns the name.
    update public.products set is_active = true where id = v_product;
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
  'Idempotent store-variant upsert. COST: the store owns it — any positive p_cost overwrites child_skus.cost on every sync (migration 0088); a null or zero cost is treated as "store sent nothing" and leaves the WMS value alone. STOCK: still seeds on create only, WMS owns it after that (migration 0084). Non-inventory/fee children never take store stock. The cost_seeded return flag means "cost written from the store on this call". NAME: set on create only — an existing product is never renamed by a sync (migration 0109). SECURITY INVOKER: catalog sync calls this with the service-role client.';

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
  -- 0108: the weight this child already carries in WMS, if any.
  v_existing_grams numeric;
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
  select cs.id, cs.product_id, cs.cost, cs.grams_per_unit
    into v_child, v_product, v_cost, v_existing_grams
    from public.child_skus cs
   where cs.site_id = p_site_id and cs.store_variant_id = p_store_variant_id
   limit 1;

  if v_child is not null then
    -- ---- 0108: WMS OWNS THE WEIGHT ONCE IT IS SET --------------------------
    -- A store spelling we cannot parse is indistinguishable from a store
    -- spelling we parse WRONG, and the wrong answer used to be written
    -- straight over a correct weight with nothing to catch it. So: record the
    -- disagreement and leave the WMS value alone. A null weight still takes
    -- the store's number — null means "we never knew", not "we decided".
    if v_existing_grams is not null and v_existing_grams <> p_grams_per_unit then
      insert into public.store_weight_conflicts
        (child_sku_id, site_id, channel, store_variant_id,
         wms_grams_per_unit, store_grams_per_unit)
      values
        (v_child, p_site_id, coalesce(p_channel, 'store'), p_store_variant_id,
         v_existing_grams, p_grams_per_unit)
      -- A repeat of the SAME disagreement bumps the counter and nothing else.
      -- Deliberately does NOT clear resolved_at: if ops has already decided
      -- WMS is right and the store's naming will not change, every later sync
      -- would otherwise reopen the row and nag forever. A store that starts
      -- sending a DIFFERENT wrong weight gets its own row.
      on conflict (child_sku_id, store_grams_per_unit) do update
        set last_seen_at = now(),
            seen_count   = store_weight_conflicts.seen_count + 1;
    end if;

    -- 0088: a positive store cost now wins on every sync, not just the first.
    v_seeded := (p_cost is not null and p_cost > 0);
    begin
      update public.child_skus
         set sku = v_sku, price = v_price, is_active = true,
             grams_per_unit = coalesce(v_existing_grams, p_grams_per_unit),
             variant_label  = coalesce(variant_label, v_label),
             cost = case when v_seeded then p_cost else cost end
       where id = v_child;
    exception when unique_violation then
      -- SKU collides with another child at this site; keep the mapping, drop sku.
      update public.child_skus
         set sku = null, price = v_price, is_active = true,
             grams_per_unit = coalesce(v_existing_grams, p_grams_per_unit),
             variant_label  = coalesce(variant_label, v_label),
             cost = case when v_seeded then p_cost else cost end
       where id = v_child;
    end;
    -- 0109: the store no longer renames an existing product; WMS owns the name.
    update public.products set is_active = true where id = v_product;
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
  'Idempotent weight-variant upsert. WEIGHT: WMS owns it — grams_per_unit is taken from the store on create or while null, and a later store weight that disagrees is refused and logged to store_weight_conflicts (migration 0108). COST: the store owns it — any positive p_cost overwrites on every sync (0088). STOCK: seeds on create only (0085). NAME: set on create only — an existing product is never renamed by a sync (migration 0109). SECURITY INVOKER: catalog sync calls this with the service-role client.';

commit;
