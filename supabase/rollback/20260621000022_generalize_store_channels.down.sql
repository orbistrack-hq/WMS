-- ============================================================================
-- Rollback for migration 0022 (generalize_store_channels).
--
-- Reverses the channel-neutral rename back to the Shopify-specific layer.
-- Safe only while every store_connections / store_order_imports row is
-- channel = 'shopify' (the case immediately after 0022 on existing data, and
-- before any WooCommerce rows are added). If WooCommerce rows exist, remove
-- them first — they have no place in the Shopify-only schema.
--
-- Order: drop dependent objects, rename tables/columns back, then recreate the
-- original constraints / policies / view / function.
-- ============================================================================

begin;

-- --- Drop dependent objects created/renamed by 0022 -------------------------
drop view if exists public.store_credential_status;
drop policy if exists store_connections_rw on public.store_connections;
drop policy if exists store_order_imports_read on public.store_order_imports;
drop function if exists public.upsert_store_variant(uuid, text, text, text, numeric, numeric, integer, text);

alter table public.store_connections
  drop constraint if exists store_connections_channel_source_key;
alter table public.store_order_imports
  drop constraint if exists store_order_imports_channel_source_external_key;

-- --- Drop columns added by 0022 ---------------------------------------------
alter table public.store_connections   drop column if exists channel;
alter table public.store_order_imports drop column if exists channel;
alter table public.store_secrets
  drop column if exists consumer_key,
  drop column if exists consumer_secret,
  drop column if exists webhook_secret;

-- --- Rename columns back -----------------------------------------------------
alter table public.store_connections   rename column source to shop_domain;
alter table public.store_order_imports rename column source to shop_domain;
alter table public.store_order_imports rename column external_order_id to shopify_order_id;

-- --- Rename tables back ------------------------------------------------------
alter table public.store_connections   rename to shopify_connections;
alter table public.store_secrets        rename to shopify_secrets;
alter table public.store_order_imports rename to shopify_order_imports;

-- --- Recreate original constraints ------------------------------------------
alter table public.shopify_connections
  add constraint shopify_connections_shop_domain_key unique (shop_domain);
alter table public.shopify_order_imports
  add constraint shopify_order_imports_shop_domain_shopify_order_id_key
    unique (shop_domain, shopify_order_id);

-- --- Recreate original policies (matching 0015 + 0013 behaviour) -------------
create policy shopify_connections_rw on public.shopify_connections
  for all using (public.can_access_site(site_id))
  with check (public.can_access_site(site_id));
create policy shopify_order_imports_read on public.shopify_order_imports
  for select using (auth.uid() is not null);

-- --- Recreate the Shopify-only status view (from 0018) ----------------------
create or replace view public.shopify_credential_status as
select c.id as connection_id,
       (s.access_token is not null and length(btrim(s.access_token)) > 0) as has_token,
       (s.api_secret  is not null and length(btrim(s.api_secret))  > 0) as has_secret
  from public.shopify_connections c
  left join public.shopify_secrets s on s.connection_id = c.id
 where public.can_access_site(c.site_id);
grant select on public.shopify_credential_status to authenticated;

-- --- Recreate upsert_shopify_variant (7-arg, from 0020) ---------------------
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

  elsif v_sku is not null then
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
      v_created := false;
    else
      v_child := null;
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
          v_child := null;
        end;
      end if;

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
    v_seeded := (p_cost is not null);
    insert into public.products(name) values (p_name) returning id into v_product;
    insert into public.child_skus
      (product_id, site_id, sku, store_variant_id, price, cost)
    values (v_product, p_site_id, null, p_store_variant_id, v_price, coalesce(p_cost, 0))
    returning id into v_child;
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

grant execute on function
  public.upsert_shopify_variant(uuid, text, text, text, numeric, numeric, integer)
  to authenticated;

commit;
