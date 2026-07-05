-- WMS — Migration 0017 (shopify_cost_inventory_sync): DOWN
-- 0017 added: the 'shopify_sync' ledger reason, set_on_hand_to(), and a 7-arg
-- upsert_shopify_variant (cost seed + inventory qty) replacing the 5-arg one.
-- Reverse all three, restoring the prior (0014) 5-arg function and the pre-0017
-- (0002) inventory_ledger reason set.
begin;

-- 1. Drop the 7-arg variant + the store-sync setter, restore the 0014 5-arg fn.
drop function if exists public.upsert_shopify_variant(uuid,text,text,text,numeric,numeric,integer);
drop function if exists public.set_on_hand_to(uuid,integer,text,uuid,text);

create or replace function public.upsert_shopify_variant(
  p_site_id          uuid,
  p_store_variant_id text,
  p_name             text,
  p_sku              text default null,
  p_price            numeric default 0
) returns table(child_sku_id uuid, created boolean)
language plpgsql as $$
declare
  v_child   uuid;
  v_product uuid;
  v_sku     text := nullif(btrim(coalesce(p_sku, '')), '');
  v_price   numeric := coalesce(p_price, 0);
begin
  if p_site_id is null or nullif(btrim(coalesce(p_store_variant_id,'')),'') is null then
    raise exception 'upsert_shopify_variant: site and store_variant_id are required';
  end if;

  select cs.id, cs.product_id into v_child, v_product
    from public.child_skus cs
   where cs.site_id = p_site_id and cs.store_variant_id = p_store_variant_id
   limit 1;

  if v_child is not null then
    begin
      update public.child_skus
         set sku = v_sku, price = v_price, is_active = true
       where id = v_child;
    exception when unique_violation then
      update public.child_skus
         set sku = null, price = v_price, is_active = true
       where id = v_child;
    end;
    update public.products set name = p_name, is_active = true where id = v_product;
    return query select v_child, false;
  else
    insert into public.products(name) values (p_name) returning id into v_product;
    begin
      insert into public.child_skus
        (product_id, site_id, sku, store_variant_id, price, cost)
      values (v_product, p_site_id, v_sku, p_store_variant_id, v_price, 0)
      returning id into v_child;
    exception when unique_violation then
      insert into public.child_skus
        (product_id, site_id, sku, store_variant_id, price, cost)
      values (v_product, p_site_id, null, p_store_variant_id, v_price, 0)
      returning id into v_child;
    end;
    return query select v_child, true;
  end if;
end;
$$;

-- 2. Restore the pre-0017 (migration 0002) inventory_ledger reason set.
alter table public.inventory_ledger drop constraint inventory_ledger_reason_check;
alter table public.inventory_ledger add constraint inventory_ledger_reason_check
  check (reason in (
    'order_reserve','order_release','order_consume',
    'layaway_remove','layaway_cancel','layaway_consume',
    'manual_adjustment','receipt','correction'));

commit;
