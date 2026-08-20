-- ============================================================================
-- WMS — Migration 0094: reconcile only enqueues SKUs the channel can address
--
-- WHAT WENT WRONG WITH 0093
-- The reconcile copied the enqueue trigger's mapping gate: store_variant_id is
-- not null. That is the right test for WooCommerce, which addresses stock at
-- /products/{id} or /products/{parent}/variations/{id}. It is the WRONG test for
-- Shopify, which writes to inventory_levels/set.json and needs
-- store_inventory_item_id — a DIFFERENT column, added by 0026 and only
-- populated when a product sync sees inventory_item_id on the variant payload.
--
-- So on a Shopify site every SKU imported before 0026 (or through a path that
-- didn't carry the inventory item) was mapped but unpushable. Reconcile enqueued
-- them anyway, the drain marked each one permanently 'skipped' with "Missing
-- Shopify inventory_item_id", and because 'skipped' is terminal while reconcile
-- happily mints a fresh row, every press of "Re-push all stock" regenerated the
-- same dead jobs — burning drain time and time budget that the pushable SKUs
-- needed. Observed live: 231 enqueued, 58 skipped, 0 pushed.
--
-- The fix is to make the gate channel-aware, so reconcile only ever enqueues
-- work that can actually succeed. Unpushable SKUs are then a REPORTING problem
-- (fix the mapping, see reconcile_outbound_blockers below) instead of silent
-- queue noise.
--
-- The trigger in 0026 is deliberately left alone: it fires one row at a time on
-- real movements, so a rare unpushable enqueue there is cheap and its 'skipped'
-- row is a useful signal. It's the bulk path that can't afford to be wrong.
--
-- Reverse with rollback/20260819000094_reconcile_channel_mapping_gate.down.sql.
-- ============================================================================

begin;

create or replace function public.reconcile_outbound_inventory_for_site(
  p_site_id uuid
) returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_channel  text;
  v_location text;
  v_count    integer;
begin
  if p_site_id is null then
    return 0;
  end if;

  -- Resolve the SAME connection claim_outbound_inventory_jobs will resolve, so
  -- the mapping we test against is the one the push will actually use.
  select sc.channel, sc.inventory_location_id
    into v_channel, v_location
    from public.store_connections sc
   where sc.site_id = p_site_id
     and sc.is_active
     and sc.sync_inventory_outbound
   limit 1;

  if v_channel is null then
    return 0;  -- no active, outbound-enabled connection: nothing can be pushed
  end if;

  -- Shopify writes stock at a location. Without one on the connection EVERY push
  -- skips, so enqueuing would just manufacture terminal rows. The integrations
  -- page already badges this state ("No location — Sync products first").
  if v_channel = 'shopify' and v_location is null then
    return 0;
  end if;

  with candidates as (
    select cs.id                                 as child_sku_id,
           cs.site_id                            as site_id,
           coalesce(il.on_hand - il.reserved, 0) as desired_available
      from public.child_skus cs
      join public.inventory_levels il on il.child_sku_id = cs.id
     where cs.site_id = p_site_id
       and coalesce(cs.is_active, true)
       and case v_channel
             -- Shopify addresses stock by InventoryItem, not by variant.
             when 'shopify'     then cs.store_inventory_item_id is not null
             when 'woocommerce' then cs.store_variant_id is not null
             else false
           end
  ),
  upserted as (
    insert into public.store_outbound_inventory_jobs
      (child_sku_id, site_id, desired_available)
    select child_sku_id, site_id, desired_available from candidates
    on conflict (child_sku_id) where status = 'pending'
    do update set desired_available = excluded.desired_available,
                  next_attempt_at   = now(),
                  updated_at        = now()
    returning 1
  )
  select count(*) into v_count from upserted;

  return coalesce(v_count, 0);
end;
$$;

-- ----------------------------------------------------------------------------
-- Companion view: the SKUs reconcile now (correctly) refuses to enqueue, so
-- "unpushable" is visible instead of just absent. Security-invoker, so it
-- inherits child_skus' site scoping.
-- ----------------------------------------------------------------------------
create or replace view public.reconcile_outbound_blockers
with (security_invoker = true) as
select cs.site_id,
       conn.channel,
       cs.id  as child_sku_id,
       p.name as product_name,
       cs.sku,
       cs.store_variant_id,
       cs.store_inventory_item_id,
       case
         when conn.channel = 'shopify' and cs.store_inventory_item_id is null
           then 'Missing Shopify inventory_item_id — run Backfill inventory IDs or re-sync products'
         when conn.channel = 'woocommerce' and cs.store_variant_id is null
           then 'Not mapped to a WooCommerce product — re-sync products'
         else 'Unknown channel mapping'
       end as reason
  from public.child_skus cs
  join public.products p on p.id = cs.product_id
  join lateral (
    select sc.channel, sc.inventory_location_id
      from public.store_connections sc
     where sc.site_id = cs.site_id and sc.is_active and sc.sync_inventory_outbound
     limit 1
  ) conn on true
 where coalesce(cs.is_active, true)
   and case conn.channel
         when 'shopify'     then cs.store_inventory_item_id is null
         when 'woocommerce' then cs.store_variant_id is null
         else true
       end;

grant select on public.reconcile_outbound_blockers to authenticated;

commit;
