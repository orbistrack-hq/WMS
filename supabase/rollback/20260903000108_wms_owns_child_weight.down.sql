-- ============================================================================
-- WMS — Rollback 0108: restore store-owned weights (migration 0088 behaviour)
--
-- Restores upsert_store_weight_variant to the 0088 body, where every sync
-- overwrites grams_per_unit, and drops store_weight_conflicts.
--
-- WARNING: any unresolved conflict rows are lost, and the store regains the
-- ability to silently rewrite a correct weight. Export the table first if the
-- open rows still matter:
--   copy (select * from public.store_weight_conflicts where resolved_at is null)
--     to stdout with csv header;
-- ============================================================================

begin;

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

drop table if exists public.store_weight_conflicts;

commit;
