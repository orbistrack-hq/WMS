-- ============================================================================
-- WMS — Migration 0014: Shopify product/variant sync
--
-- WMS has no variant tier below a product (DECISION 1): the sellable unit is a
-- child SKU = one product at one site. So each Shopify VARIANT maps to its own
-- WMS product + child SKU at the connected store's site, anchored by
-- store_variant_id. upsert_shopify_variant() does that idempotently.
--
-- Conflict policy for synced rows: Shopify owns name / price / sku; WMS owns
-- cost (set to 0 on create, never overwritten by a sync). Re-running a sync
-- updates in place rather than duplicating.
--
-- Also: shopify_secrets holds the Admin API token for the backfill pull, kept
-- admin-only (operators never see it); last_synced_at tracks the last backfill.
-- ============================================================================

begin;

alter table public.shopify_connections
  add column if not exists last_synced_at timestamptz;

-- Admin API access token, separate from shopify_connections so RLS can lock it
-- to admins (RLS is row-level, not column-level — a separate table is the clean
-- way to keep the token away from operator reads).
create table public.shopify_secrets (
  connection_id uuid primary key
                  references public.shopify_connections(id) on delete cascade,
  access_token  text not null,
  updated_at    timestamptz not null default now()
);
alter table public.shopify_secrets enable row level security;
create policy shopify_secrets_admin on public.shopify_secrets
  for all using (public.is_admin()) with check (public.is_admin());
create trigger t_shopify_secrets_updated before update on public.shopify_secrets
  for each row execute function public.set_updated_at();

-- Create or update the WMS product + child SKU for one Shopify variant.
-- Returns whether a new product/SKU was created (vs. updated in place).
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
    -- Update price/sku/name; preserve cost. If the sku collides with another
    -- SKU at this site, keep the variant but drop the sku rather than failing.
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

comment on function public.upsert_shopify_variant is
  'Idempotently map one Shopify variant to a WMS product + child SKU at a site (keyed by store_variant_id). Shopify owns name/price/sku; WMS owns cost.';

commit;
