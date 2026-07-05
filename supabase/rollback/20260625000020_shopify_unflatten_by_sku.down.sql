-- WMS — Migration 0020 (shopify_unflatten_by_sku): DOWN
-- 0020 only redefined upsert_shopify_variant (7-arg). Restore the prior (0017)
-- body: create-a-new-parent-per-variant, before SKU-based un-flattening.
begin;

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

  if p_inventory_qty is not null then
    perform public.set_on_hand_to(
      v_child, p_inventory_qty, 'shopify', null,
      'Inventory synced from Shopify');
  end if;

  return query select v_child, v_created, v_seeded;
end;
$$;

commit;
