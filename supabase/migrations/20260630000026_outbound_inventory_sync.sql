-- ============================================================================
-- WMS — Migration 0026: outbound inventory sync (WMS -> store)
--
-- The store integration has been INBOUND only (store -> WMS). This adds the
-- outbound half: when WMS stock changes, push the new AVAILABLE quantity
-- (on_hand - reserved) to the connected storefront so it can't oversell stock
-- already committed to WMS orders.
--
-- Design (durable, idempotent, no new infra required):
--   * A DB trigger on inventory_ledger is the single capture point — it fires
--     for EVERY stock movement regardless of which code path caused it (manual
--     adjust, order reserve/release/consume, layaway, packing, receipt). It
--     enqueues one COALESCED job per child SKU into store_outbound_inventory_jobs
--     carrying the latest target available.
--   * LOOP SUPPRESSION: movements whose reason is 'shopify_sync' came FROM a
--     store sync; re-pushing them would fight the store, so they're skipped.
--   * A worker (lib/store-sync/outbound.ts) claims jobs (FOR UPDATE SKIP LOCKED),
--     pushes to the store API, and marks done / retries with exponential
--     backoff / fails after a cap. claim+complete are SECURITY DEFINER and only
--     the service role may call them.
--
-- Conflict policy (outbound): available is computed by WMS and SET (absolute,
-- not delta) on the store, so repeated pushes converge instead of drifting.
-- Inbound on_hand sync (set_on_hand_to, reason 'shopify_sync') still lets the
-- store seed WMS; the two directions don't loop because of the suppression above.
--
-- Per-connection rollout: sync_inventory_outbound defaults FALSE, so nothing is
-- pushed until an admin enables a specific store ("one store at a time").
--
-- Reverse with rollback/20260630000026_outbound_inventory_sync.down.sql.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. External identifiers needed to address stock on the store side.
--    Shopify: inventory_item_id (+ a location, per connection below).
--    WooCommerce: variations are addressed as /products/{parent}/variations/{id}
--    so a variation child needs its parent product id (store_parent_id); simple
--    products use store_variant_id alone and leave store_parent_id null.
--    Backfilled by a product re-sync; null = "not yet mapped, skip the push".
-- ----------------------------------------------------------------------------
alter table public.child_skus
  add column if not exists store_inventory_item_id text,
  add column if not exists store_parent_id text;

-- ----------------------------------------------------------------------------
-- 2. Per-connection outbound config.
-- ----------------------------------------------------------------------------
alter table public.store_connections
  add column if not exists inventory_location_id   text,   -- Shopify location to write
  add column if not exists sync_inventory_outbound boolean not null default false;

-- ----------------------------------------------------------------------------
-- 3. Durable outbound job queue. One COALESCED pending row per child SKU.
-- ----------------------------------------------------------------------------
create table public.store_outbound_inventory_jobs (
  id                uuid primary key default gen_random_uuid(),
  child_sku_id      uuid not null references public.child_skus(id) on delete cascade,
  site_id           uuid not null references public.sites(id)      on delete cascade,
  desired_available integer not null,
  status            text not null default 'pending'
                      check (status in ('pending','processing','done','failed','skipped')),
  attempts          integer not null default 0,
  last_error        text,
  next_attempt_at   timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  processed_at      timestamptz
);
-- At most one PENDING job per child SKU: a burst of movements collapses to the
-- latest target (the ON CONFLICT in the trigger below updates it in place).
create unique index store_outbound_jobs_one_pending
  on public.store_outbound_inventory_jobs (child_sku_id) where status = 'pending';
create index store_outbound_jobs_due_idx
  on public.store_outbound_inventory_jobs (next_attempt_at) where status = 'pending';
create index store_outbound_jobs_site_idx
  on public.store_outbound_inventory_jobs (site_id, status);

create trigger store_outbound_jobs_updated
  before update on public.store_outbound_inventory_jobs
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 4. Enqueue trigger on the inventory ledger.
-- ----------------------------------------------------------------------------
create or replace function public.tg_enqueue_outbound_inventory()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_site    uuid;
  v_avail   integer;
  v_enabled boolean;
  v_mapped  boolean;
begin
  -- Loop suppression: never push back a movement that came FROM a store sync.
  if new.reason = 'shopify_sync' then
    return new;
  end if;

  select cs.site_id, (cs.store_variant_id is not null)
    into v_site, v_mapped
    from public.child_skus cs
   where cs.id = new.child_sku_id;
  if v_site is null or not coalesce(v_mapped, false) then
    return new;  -- unknown SKU or not mapped to any store variant
  end if;

  -- Only enqueue when the SKU's site has an active, outbound-enabled connection.
  select coalesce(bool_or(c.is_active and c.sync_inventory_outbound), false)
    into v_enabled
    from public.store_connections c
   where c.site_id = v_site;
  if not v_enabled then
    return new;
  end if;

  select (il.on_hand - il.reserved) into v_avail
    from public.inventory_levels il
   where il.child_sku_id = new.child_sku_id;
  if v_avail is null then
    return new;
  end if;

  insert into public.store_outbound_inventory_jobs
    (child_sku_id, site_id, desired_available)
  values (new.child_sku_id, v_site, v_avail)
  on conflict (child_sku_id) where status = 'pending'
  do update set desired_available = excluded.desired_available,
               next_attempt_at    = now(),
               updated_at         = now();

  return new;
end;
$$;

create trigger inventory_ledger_outbound
  after insert on public.inventory_ledger
  for each row execute function public.tg_enqueue_outbound_inventory();

-- ----------------------------------------------------------------------------
-- 5. Claim due jobs atomically (worker entry point). Returns each job enriched
--    with the routing facts the pusher needs (everything but the secret token).
-- ----------------------------------------------------------------------------
create or replace function public.claim_outbound_inventory_jobs(p_limit integer default 25)
returns table(
  job_id                  uuid,
  child_sku_id            uuid,
  site_id                 uuid,
  desired_available       integer,
  attempts                integer,
  channel                 text,
  source                  text,
  store_variant_id        text,
  store_inventory_item_id text,
  store_parent_id         text,
  inventory_location_id   text
) language plpgsql security definer set search_path = '' as $$
begin
  return query
  with due as (
    select j.id
      from public.store_outbound_inventory_jobs j
     where j.status = 'pending' and j.next_attempt_at <= now()
     order by j.next_attempt_at
     for update skip locked
     limit greatest(coalesce(p_limit, 25), 1)
  ),
  claimed as (
    update public.store_outbound_inventory_jobs j
       set status = 'processing', updated_at = now()
      from due
     where j.id = due.id
     returning j.id, j.child_sku_id, j.site_id, j.desired_available, j.attempts
  )
  -- Push the LIVE available at send time, not the value snapshotted at enqueue.
  -- This keeps a coalesced/stale job correct and avoids ever pushing a number
  -- that a later (possibly suppressed) movement has since changed.
  select c.id, c.child_sku_id, c.site_id,
         coalesce(il.on_hand - il.reserved, c.desired_available) as desired_available,
         c.attempts,
         conn.channel, conn.source, cs.store_variant_id,
         cs.store_inventory_item_id, cs.store_parent_id, conn.inventory_location_id
    from claimed c
    join public.child_skus cs on cs.id = c.child_sku_id
    left join public.inventory_levels il on il.child_sku_id = c.child_sku_id
    left join lateral (
      select channel, source, inventory_location_id
        from public.store_connections sc
       where sc.site_id = c.site_id and sc.is_active and sc.sync_inventory_outbound
       limit 1
    ) conn on true;
end;
$$;

-- ----------------------------------------------------------------------------
-- 6. Complete a job: success, permanent skip, or failure with backoff. On a
--    retry, if a NEWER pending job already exists for the same SKU (created
--    while this one processed), this one is marked superseded ('done') so the
--    one-pending-per-SKU invariant holds and the latest target wins.
-- ----------------------------------------------------------------------------
create or replace function public.complete_outbound_inventory_job(
  p_job_id       uuid,
  p_ok           boolean,
  p_error        text    default null,
  p_skip         boolean default false,
  p_max_attempts integer default 8
) returns void language plpgsql security definer set search_path = '' as $$
declare
  v public.store_outbound_inventory_jobs;
  v_backoff integer;
begin
  select * into v from public.store_outbound_inventory_jobs where id = p_job_id for update;
  if not found then return; end if;

  if p_ok then
    update public.store_outbound_inventory_jobs
       set status='done', processed_at=now(), last_error=null, updated_at=now()
     where id=p_job_id;
    return;
  end if;

  if p_skip then
    update public.store_outbound_inventory_jobs
       set status='skipped', processed_at=now(), last_error=p_error, updated_at=now()
     where id=p_job_id;
    return;
  end if;

  -- A newer pending job for this SKU already carries a fresher target.
  if exists (select 1 from public.store_outbound_inventory_jobs o
              where o.child_sku_id = v.child_sku_id and o.status = 'pending'
                and o.id <> p_job_id) then
    update public.store_outbound_inventory_jobs
       set status='done', processed_at=now(),
           last_error=coalesce(p_error,'superseded'), updated_at=now()
     where id=p_job_id;
    return;
  end if;

  v_backoff := least(power(2, v.attempts + 1)::integer, 3600);  -- seconds, capped 1h
  update public.store_outbound_inventory_jobs
     set attempts        = v.attempts + 1,
         last_error      = p_error,
         status          = case when v.attempts + 1 >= p_max_attempts then 'failed' else 'pending' end,
         next_attempt_at = now() + make_interval(secs => v_backoff),
         processed_at    = case when v.attempts + 1 >= p_max_attempts then now() else processed_at end,
         updated_at      = now()
   where id=p_job_id;
end;
$$;

-- ----------------------------------------------------------------------------
-- 7. RLS + grants. Reads scoped by site (for the integrations UI); writes only
--    via the SECURITY DEFINER functions/trigger. claim/complete are service-
--    role only (the worker), never callable by app users.
-- ----------------------------------------------------------------------------
alter table public.store_outbound_inventory_jobs enable row level security;
create policy store_outbound_jobs_read on public.store_outbound_inventory_jobs
  for select using (public.can_access_site(site_id));
grant select on public.store_outbound_inventory_jobs to authenticated;

revoke insert, update, delete on public.store_outbound_inventory_jobs from public;
do $$
declare r text;
begin
  foreach r in array array['authenticated','anon','app_user'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke insert, update, delete on public.store_outbound_inventory_jobs from %I', r);
      execute format('revoke execute on function public.claim_outbound_inventory_jobs(integer) from %I', r);
      execute format('revoke execute on function public.complete_outbound_inventory_job(uuid,boolean,text,boolean,integer) from %I', r);
      execute format('revoke execute on function public.tg_enqueue_outbound_inventory() from %I', r);
    end if;
  end loop;
end $$;
revoke execute on function public.claim_outbound_inventory_jobs(integer) from public;
revoke execute on function public.complete_outbound_inventory_job(uuid,boolean,text,boolean,integer) from public;
revoke execute on function public.tg_enqueue_outbound_inventory() from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.claim_outbound_inventory_jobs(integer) to service_role;
    grant execute on function public.complete_outbound_inventory_job(uuid,boolean,text,boolean,integer) to service_role;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 8. Status rollup for the integrations UI (counts per site, security-invoker
--    so it inherits the job table's site-scoped RLS).
-- ----------------------------------------------------------------------------
create view public.store_outbound_sync_status with (security_invoker = true) as
select site_id,
       count(*) filter (where status = 'pending')    as pending,
       count(*) filter (where status = 'processing') as processing,
       count(*) filter (where status = 'failed')     as failed,
       count(*) filter (where status = 'skipped')    as skipped,
       max(processed_at) filter (where status = 'done') as last_done_at
from public.store_outbound_inventory_jobs
group by site_id;

grant select on public.store_outbound_sync_status to authenticated;

commit;
