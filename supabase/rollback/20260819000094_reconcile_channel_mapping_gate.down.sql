-- Rollback for migration 0094. Drops the blockers view and restores the 0093
-- reconcile body (mapping gate on store_variant_id only). NOTE: reverting
-- re-introduces the Shopify bug where SKUs without store_inventory_item_id are
-- enqueued and then permanently skipped.

begin;

drop view if exists public.reconcile_outbound_blockers;

create or replace function public.reconcile_outbound_inventory_for_site(
  p_site_id uuid
) returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_enabled boolean;
  v_count   integer;
begin
  if p_site_id is null then
    return 0;
  end if;

  select coalesce(bool_or(c.is_active and c.sync_inventory_outbound), false)
    into v_enabled
    from public.store_connections c
   where c.site_id = p_site_id;
  if not v_enabled then
    return 0;
  end if;

  with candidates as (
    select cs.id                                 as child_sku_id,
           cs.site_id                            as site_id,
           coalesce(il.on_hand - il.reserved, 0) as desired_available
      from public.child_skus cs
      join public.inventory_levels il on il.child_sku_id = cs.id
     where cs.site_id = p_site_id
       and cs.store_variant_id is not null
       and coalesce(cs.is_active, true)
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

commit;
