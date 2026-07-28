-- ============================================================================
-- WMS — Migration 0085: the WEIGHT-variant sync also seeds on create only
--
-- Migration 0084 fixed upsert_store_variant. It missed upsert_store_weight_variant,
-- which is the path EVERY weight variant takes (3.5g / 7g / 14g / 28g) — i.e.
-- nearly the whole cannabis catalog. lib/{shopify,woocommerce}/import-products.ts
-- picks between the two RPCs on whether the variation parses as a weight.
--
-- Proof it was still draining: a Woo product sync at 2026-07-27 17:55, AFTER 0084
-- was live, wrote five fresh negative rows — BC-SD14G -1, BC-SD3.5G -2, BC-SM7G -2,
-- BC-SS3.5G -1, BC-SS7G -1. All weight variants.
--
-- Same rule as 0084: the store SEEDS on create, WMS OWNS from then on. This also
-- adds the track_inventory guard that 0068 gave the other path, so the two stop
-- diverging — that divergence is exactly why 0084 looked complete and was not.
--
-- Recreated verbatim from migration 0057 apart from those two guards.
-- SECURITY INVOKER preserved (catalog sync uses the service-role client).
--
-- Reverse with rollback/20260727000085_weight_variant_seed_on_create_only.down.sql.
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
    v_seeded := (p_cost is not null and coalesce(v_cost, 0) = 0);
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

  v_seeded := (p_cost is not null);

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
             cost = case when v_seeded and coalesce(cost, 0) = 0 then p_cost else cost end
       where id = v_child;
    exception when unique_violation then
      update public.child_skus
         set store_variant_id = p_store_variant_id, sku = null, price = v_price,
             is_active = true, variant_label = coalesce(variant_label, v_label),
             cost = case when v_seeded and coalesce(cost, 0) = 0 then p_cost else cost end
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

  -- ---- 0085: SEED ONLY (mirrors 0084 on the non-weighted path) -------------
  -- Take the store's count only when this call CREATED the child SKU. On every
  -- later sync WMS owns on_hand and the store number is ignored.
  --
  -- Also skip non-inventory children, matching the guard migration 0068 added to
  -- upsert_store_variant. The two paths had drifted apart, which is how this one
  -- kept draining after 0084 shipped.
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

commit;
