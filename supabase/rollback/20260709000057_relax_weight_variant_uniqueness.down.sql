-- ============================================================================
-- Rollback 0057 — restore weight-based child uniqueness and the 0030 sync body.
--
-- Drops the null-sku partial guard, recreates the original
-- child_skus_product_site_variant_key, and restores upsert_store_weight_variant
-- to its migration-0030 (sku-agnostic adoption) form.
--
-- NOTE: recreating the strict weight index will FAIL if two same-weight children
-- (e.g. an ounce special) already exist at one (product, site) — that is
-- intentional, mirroring 0028's down: you cannot un-model live data silently.
-- Merge or remove the extra same-weight children first.
-- ============================================================================

begin;

-- ---- 1. Restore the 0030 sync body (adopt any child at product/site/weight) --
create or replace function public.upsert_store_weight_variant(
  p_site_id          uuid,
  p_store_variant_id text,
  p_strain_name      text,
  p_grams_per_unit   numeric,
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

  v_label := rtrim(rtrim(p_grams_per_unit::text, '0'), '.') || 'g';

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

-- ---- 2. Restore the 0039 merge_products conflict rule (per-weight) ----------
create or replace function public.merge_products(
  p_survivor uuid,
  p_losers   uuid[],
  p_dry_run  boolean default false
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v