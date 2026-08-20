-- ============================================================================
-- WMS — Migration 0093: outbound inventory reconcile (backfill the queue)
--
-- THE GAP THIS CLOSES
-- The enqueue trigger from migration 0026 (tg_enqueue_outbound_inventory)
-- evaluates its gates at the instant the inventory_ledger row is written: the
-- child SKU must be mapped (store_variant_id not null) AND the site must have a
-- connection that is is_active AND sync_inventory_outbound. If either is false
-- it returns silently — no job row, no error, nothing in the Skipped counter.
--
-- So allocating stock to a store whose connection isn't wired up yet (webhooks
-- never registered, outbound flag still at its FALSE default, products not yet
-- synced) is a SILENT NO-OP. Turning the store on later does not backfill: the
-- queue is empty, so the drain has nothing to push and the storefront keeps
-- showing stale stock until the next unrelated movement on that same SKU.
--
-- Draining can't fix this — you can only drain jobs that exist. This adds the
-- missing half: a reconcile that ENQUEUES one job per mapped child SKU on a
-- site, from current inventory_levels, so "enable the store" / "re-push stock"
-- converges the storefront on WMS truth regardless of what was missed earlier.
--
-- Idempotent and safe to spam:
--   * Respects the one-pending-per-SKU partial unique index — a re-run updates
--     the existing pending row's target in place instead of piling up.
--   * Pushes are absolute SETs (see 0026), so a redundant reconcile can never
--     corrupt store stock.
--   * A SKU whose earlier job went terminal ('skipped' after a bad mapping, or
--     'failed' after the attempt cap) gets a FRESH pending row here — this is
--     the supported way to retry those once the underlying cause is fixed.
--
-- Callers: setOutboundSync (when enabling), setConnectionActive (when
-- activating), and the manual "Re-push all stock" action — all of which follow
-- it with kickOutboundDrain(). Sealed to service_role like claim/complete;
-- the app authorizes the user, then calls it with the admin client.
--
-- Reverse with rollback/20260819000093_outbound_inventory_reconcile.down.sql.
-- ============================================================================

begin;

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

  -- Same gate the trigger uses. Reconciling a site with no active,
  -- outbound-enabled connection would enqueue jobs that the drain can only mark
  -- permanently 'skipped' (claim resolves a null channel/source), which is worse
  -- than enqueuing nothing: it manufactures terminal rows and noise in the
  -- Skipped counter on the integrations page.
  select coalesce(bool_or(c.is_active and c.sync_inventory_outbound), false)
    into v_enabled
    from public.store_connections c
   where c.site_id = p_site_id;
  if not v_enabled then
    return 0;
  end if;

  -- One job per mapped, active child SKU on the site, carrying today's
  -- available. claim_outbound_inventory_jobs re-reads live available at send
  -- time anyway, so this value is only a starting point.
  with candidates as (
    select cs.id                            as child_sku_id,
           cs.site_id                       as site_id,
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

-- Writes to the queue happen only through the SECURITY DEFINER functions; this
-- is the worker's/service role's, never callable directly by app users.
revoke execute on function public.reconcile_outbound_inventory_for_site(uuid) from public;
do $$
declare r text;
begin
  foreach r in array array['authenticated','anon','app_user'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format(
        'revoke execute on function public.reconcile_outbound_inventory_for_site(uuid) from %I',
        r
      );
    end if;
  end loop;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.reconcile_outbound_inventory_for_site(uuid) to service_role;
  end if;
end $$;

commit;
