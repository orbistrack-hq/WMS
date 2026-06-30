-- ============================================================================
-- WMS — Migration 0022: generalize the Shopify-specific store integration into
-- a channel-neutral layer so WooCommerce (and future channels) reuse the same
-- connection / secret / import / variant-mapping machinery.
--
-- Confirmed decisions: generalize (don't fork); ONE sales channel per site;
-- inbound sync only for now. Existing Shopify rows are backfilled with
-- channel = 'shopify', so current behaviour is unchanged.
--
--   shopify_connections        -> store_connections        (+ channel, shop_domain -> source)
--   shopify_secrets            -> store_secrets             (+ woo credential columns)
--   shopify_order_imports      -> store_order_imports       (+ channel, shopify_order_id -> external_order_id)
--   shopify_credential_status  -> store_credential_status   (channel-neutral booleans)
--   upsert_shopify_variant()   -> upsert_store_variant()    (+ p_channel for the ledger label)
--
-- Uniqueness moves to (channel, source) and (channel, source, external_order_id)
-- so two channels can never collide on a shared numeric id.
-- Reverse with rollback/20260621000022_generalize_store_channels.down.sql.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Connections
-- ---------------------------------------------------------------------------
alter table public.shopify_connections rename to store_connections;
alter table public.store_connections rename column shop_domain to source;
alter table public.store_connections
  add column channel text not null default 'shopify'
    check (channel in ('shopify', 'woocommerce'));

-- Uniqueness was global on shop_domain; now scoped to (channel, source).
alter table public.store_connections
  drop constraint if exists shopify_connections_shop_domain_key;
alter table public.store_connections
  add constraint store_connections_channel_source_key unique (channel, source);

-- Re-create the site-scoped RLS policy under a neutral name (logic unchanged).
drop policy if exists shopify_connections_read  on public.store_connections;
drop policy if exists shopify_connections_admin on public.store_connections;
drop policy if exists shopify_connections_rw    on public.store_connections;
create policy store_connections_rw on public.store_connections
  for all using (public.can_access_site(site_id))
  with check (public.can_access_site(site_id));

-- ---------------------------------------------------------------------------
-- 2. Secrets — one sealed table, columns per channel (all nullable, saved in
--    steps). Inherits the 0018 lockdown: RLS on, no policy, no API grants; only
--    service_role / the admin client reach it. Adding columns keeps them sealed.
-- ---------------------------------------------------------------------------
alter table public.shopify_secrets rename to store_secrets;
alter table public.store_secrets
  add column consumer_key    text,
  add column consumer_secret text,
  add column webhook_secret  text;

-- Replace the Shopify-only status view with a channel-neutral one (booleans
-- only, never secret values).
drop view if exists public.shopify_credential_status;
create view public.store_credential_status as
select c.id      as connection_id,
       c.channel as channel,
       (s.access_token    is not null and length(btrim(s.access_token))    > 0) as has_token,
       (s.api_secret      is not null and length(btrim(s.api_secret))      > 0) as has_secret,
       (s.consumer_key    is not null and length(btrim(s.consumer_key))    > 0) as has_consumer_key,
       (s.consumer_secret is not null and length(btrim(s.consumer_secret)) > 0) as has_consumer_secret,
       (s.webhook_secret  is not null and length(btrim(s.webhook_secret))  > 0) as has_webhook_secret
  from public.store_connections c
  left join public.store_secrets s on s.connection_id = c.id
 where public.can_access_site(c.site_id);

comment on view public.store_credential_status is
  'Per-connection credential setup status (booleans only, never secret values) for the integrations UI. Owner-privileged so it can read the sealed store_secrets table; rows scoped by can_access_site.';

grant select on public.store_credential_status to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Order import log
-- ---------------------------------------------------------------------------
alter table public.shopify_order_imports rename to store_order_imports;
alter table public.store_order_imports rename column shop_domain to source;
alter table public.store_order_imports rename column shopify_order_id to external_order_id;
alter table public.store_order_imports
  add column channel text not null default 'shopify'
    check (channel in ('shopify', 'woocommerce'));

alter table public.store_order_imports
  drop constraint if exists shopify_order_imports_shop_domain_shopify_order_id_key;
alter table public.store_order_imports
  add constraint store_order_imports_channel_source_external_key
    unique (channel, source, external_order_id);

-- Re-create the read policy under a neutral name; now matches on channel + source.
drop policy if exists shopify_order_imports_read on public.store_order_imports;
create policy store_order_imports_read on public.store_order_imports
  for select using (exists (
    select 1 from public.store_connections c
     where c.channel = store_order_imports.channel
       and c.source  = store_order_imports.source
       and public.can_access_site(c.site_id)));

-- ---------------------------------------------------------------------------
-- 4. Variant upsert — neutral name + channel-aware inventory ledger label.
--    Body is identical to migration 0020's upsert_shopify_variant except that
--    the on_hand sync is tagged with p_channel instead of a hardcoded 'shopify'.
-- ---------------------------------------------------------------------------
drop function if exists public.upsert_shopify_variant(uuid, text, text, text, numeric);
drop function if exists public.upsert_shopify_variant(uuid, text, text, text, numeric, numeric, integer);

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

  -- Pull store stock into WMS on_hand (logged; reservations preserved).
  if p_inventory_qty is not null then
    perform public.set_on_hand_to(
      v_child, p_inventory_qty, p_channel, null,
      format('Inventory synced from %s', initcap(coalesce(p_channel, 'store'))));
  end if;

  return query select v_child, v_created, v_seeded;
end;
$$;

comment on function public.upsert_store_variant is
  'Map one store variant (any channel) to a WMS product + child SKU. Attaches by SKU to an existing master product across sites instead of creating duplicate parents (forward-only un-flattening). Store owns name/price/sku; cost is seed-only; on_hand syncs via set_on_hand_to, tagged with p_channel.';

grant execute on function
  public.upsert_store_variant(uuid, text, text, text, numeric, numeric, integer, text)
  to authenticated;

commit;
