-- ============================================================================
-- WMS — Migration 0030: forward weight-variant sync (OrbisTrack)
--
-- The store sync flattened weights into separate parent products: variant
-- "3.5g" of Shopify product "Apple Fritter" became a WMS product
-- "Apple Fritter - 3.5g". Intake/allocation instead needs ONE strain parent
-- ("Apple Fritter") with weight-variant children (grams_per_unit) per client.
--
-- This adds a dedicated writer the import layer calls when it recognizes a
-- weight in a variant. It is SEPARATE from upsert_store_variant so the existing
-- non-weight sync path is untouched (no regression risk).
--
-- Grouping rule (forward-only, reversible): a weight variant attaches to a
-- strain parent found by EXACT name that already holds a weight child (any
-- site). The first weight variant of a strain creates that parent; later ones —
-- same store or another client's store — find it by name. This shares one strain
-- parent across clients, which is what allocation groups by. Mis-groupings are
-- correctable in the catalog and by the (later) review/backfill screen.
--
-- Reverse with rollback/20260703000030_weight_variant_sync.down.sql.
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

  -- 3. Adopt an existing child at the same (product, site, weight), else insert.
  select cs.id into v_child
    from public.child_skus cs
   where cs.product_id = v_product and cs.site_id = p_site_id
     and cs.grams_per_unit = p_grams_per_unit
   limit 1;

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

  -- Pull store stock into WMS on_hand (logged; reservations preserved).
  if p_inventory_qty is not null then
    perform public.set_on_hand_to(
      v_child, p_inventory_qty, p_channel, null,
      format('Inventory synced from %s', initcap(coalesce(p_channel, 'store'))));
  end if;

  return query select v_child, v_created, v_seeded;
end;
$$;

comment on function public.upsert_store_weight_variant is
  'Map one store variant recognized as a weight (grams_per_unit) to a shared strain parent + weight-variant child SKU. Groups weights across clients by exact strain name. Store owns name/price/sku; cost is seed-only; on_hand syncs via set_on_hand_to.';

grant execute on function
  public.upsert_store_weight_variant(uuid, text, text, numeric, text, numeric, numeric, integer, text)
  to authenticated;

commit;
