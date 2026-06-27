-- ============================================================================
-- WMS — Migration 0024: interactive pick confirmation
--
-- Turns the print-only pick list into a tracked, tap-to-confirm workflow. Two
-- small tables, both site-scoped through their fulfillment group (mirroring the
-- packaging_usage policy from 0004):
--
--   pick_progress  — per (group, child SKU): how many units are picked, and an
--                    explicit "short" flag for out-of-stock lines the picker has
--                    acknowledged. The grain matches what the pick list
--                    aggregates, so progress maps 1:1 onto the list.
--   pick_claims    — a SOFT lock: one picker holds a group at a time. Others can
--                    take over (an explicit takeover, or automatically once a
--                    claim goes stale). Never blocks hard — it just shows who's
--                    on it and lets a teammate grab it.
--
-- RPCs keep every status move on the existing guarded state machine (0007):
--   claim_pick      — claim / take over a group for the caller.
--   set_pick_qty    — clamp to the required qty, record progress, and on first
--                     pick advance the group's 'created' orders -> 'picking'
--                     via set_order_status (never a bare update).
--   pick_complete   — is every required SKU fully picked or marked short?
--   pack_group      — REPLACED to gate on pick_complete: a group with orders
--                     still on the floor can't be packed until picking is done.
--
-- Functions run as the caller (invoker), like set_order_status / pack_group, so
-- row access stays governed by RLS. New tables/functions inherit grants to
-- authenticated from the default privileges set in 0011.
-- ============================================================================

begin;

-- How long a claim stays "fresh" before anyone may take over without forcing.
-- (Inlined as a literal below; documented here for the next reader.)
--   STALE AFTER: 30 minutes of no pick activity.

-- ---------------------------------------------------------------------------
-- 1. Progress, at the (group, child SKU) grain the pick list aggregates.
-- ---------------------------------------------------------------------------
create table public.pick_progress (
  group_id     uuid not null references public.fulfillment_groups(id) on delete cascade,
  child_sku_id uuid not null references public.child_skus(id)         on delete restrict,
  qty_picked   integer not null default 0 check (qty_picked >= 0),
  short        boolean not null default false,   -- out-of-stock, acknowledged
  picked_by    uuid references public.profiles(id),
  updated_at   timestamptz not null default now(),
  primary key (group_id, child_sku_id)
);
alter table public.pick_progress enable row level security;

create policy pick_progress_read on public.pick_progress for select
  using (exists (select 1 from public.fulfillment_groups g
                 where g.id = group_id and public.can_access_site(g.site_id)));
create policy pick_progress_insert on public.pick_progress for insert
  with check (exists (select 1 from public.fulfillment_groups g
                      where g.id = group_id and public.can_access_site(g.site_id)));
create policy pick_progress_update on public.pick_progress for update
  using (exists (select 1 from public.fulfillment_groups g
                 where g.id = group_id and public.can_access_site(g.site_id)))
  with check (exists (select 1 from public.fulfillment_groups g
                      where g.id = group_id and public.can_access_site(g.site_id)));
create policy pick_progress_delete on public.pick_progress for delete
  using (public.is_admin());

-- ---------------------------------------------------------------------------
-- 2. Soft lock: one claimant per group, take-over allowed.
-- ---------------------------------------------------------------------------
create table public.pick_claims (
  group_id   uuid primary key references public.fulfillment_groups(id) on delete cascade,
  picked_by  uuid not null references public.profiles(id),
  claimed_at timestamptz not null default now(),  -- when the current holder took it
  updated_at timestamptz not null default now()   -- last pick activity (heartbeat)
);
alter table public.pick_claims enable row level security;

create policy pick_claims_read on public.pick_claims for select
  using (exists (select 1 from public.fulfillment_groups g
                 where g.id = group_id and public.can_access_site(g.site_id)));
create policy pick_claims_insert on public.pick_claims for insert
  with check (exists (select 1 from public.fulfillment_groups g
                      where g.id = group_id and public.can_access_site(g.site_id)));
create policy pick_claims_update on public.pick_claims for update
  using (exists (select 1 from public.fulfillment_groups g
                 where g.id = group_id and public.can_access_site(g.site_id)))
  with check (exists (select 1 from public.fulfillment_groups g
                      where g.id = group_id and public.can_access_site(g.site_id)));
create policy pick_claims_delete on public.pick_claims for delete
  using (public.is_admin());

-- ---------------------------------------------------------------------------
-- 3. Required quantity per child SKU for the orders still on the floor.
--    Centralized so set_pick_qty, pick_complete, and the pack gate agree.
-- ---------------------------------------------------------------------------
create or replace function public.pick_required(p_group_id uuid)
returns table (child_sku_id uuid, required integer)
language sql stable as $$
  select li.child_sku_id, sum(li.quantity)::int as required
    from public.orders o
    join public.order_line_items li on li.order_id = o.id
   where o.group_id = p_group_id
     and o.status in ('created', 'picking')   -- still to pick
   group by li.child_sku_id
$$;

-- Picking is "complete" when every required SKU is fully picked OR marked short.
create or replace function public.pick_complete(p_group_id uuid)
returns boolean language sql stable as $$
  select not exists (
    select 1
      from public.pick_required(p_group_id) req
      left join public.pick_progress pp
        on pp.group_id = p_group_id and pp.child_sku_id = req.child_sku_id
     where coalesce(pp.short, false) = false
       and coalesce(pp.qty_picked, 0) < req.required
  );
$$;

-- ---------------------------------------------------------------------------
-- 4. Claim / take over a group. Returns the resulting claim state as jsonb:
--      { holder_id, holder_name, is_self, taken_over }
--    is_self=false means someone else holds a fresh claim and the caller did
--    NOT force it — the UI offers a "Take over" (p_takeover => true).
-- ---------------------------------------------------------------------------
create or replace function public.claim_pick(
  p_group_id uuid,
  p_takeover boolean default false
) returns jsonb
language plpgsql as $$
declare
  g         public.fulfillment_groups;
  v_existing public.pick_claims;
  v_fresh   boolean;
  v_uid     uuid := auth.uid();
begin
  select * into g from public.fulfillment_groups where id = p_group_id for update;
  if not found then raise exception 'claim_pick: group % not found', p_group_id; end if;

  select * into v_existing from public.pick_claims where group_id = p_group_id;
  v_fresh := v_existing.picked_by is not null
             and v_existing.updated_at > now() - interval '30 minutes';

  -- Someone else holds a fresh claim and we're not forcing: report, don't grab.
  if v_fresh and v_existing.picked_by <> v_uid and not p_takeover then
    return jsonb_build_object(
      'holder_id',   v_existing.picked_by,
      'holder_name', (select full_name from public.profiles where id = v_existing.picked_by),
      'is_self',     false,
      'taken_over',  false);
  end if;

  insert into public.pick_claims (group_id, picked_by, claimed_at, updated_at)
  values (p_group_id, v_uid, now(), now())
  on conflict (group_id) do update
    set picked_by  = v_uid,
        updated_at = now(),
        -- keep the original claimed_at if the same person is re-claiming
        claimed_at = case when pick_claims.picked_by = v_uid
                          then pick_claims.claimed_at else now() end;

  return jsonb_build_object(
    'holder_id',   v_uid,
    'holder_name', (select full_name from public.profiles where id = v_uid),
    'is_self',     true,
    'taken_over',  coalesce(v_fresh and v_existing.picked_by <> v_uid, false));
end;
$$;

comment on function public.claim_pick(uuid, boolean) is
  'Claim (or take over) a fulfillment group for picking. Soft lock: returns the current holder when another picker holds a fresh claim and p_takeover is false.';

-- ---------------------------------------------------------------------------
-- 5. Record a pick. Clamps to the required qty, flags short, advances the
--    group off 'created' on first activity. Returns jsonb:
--      { child_sku_id, qty_picked, required, short, complete }
-- ---------------------------------------------------------------------------
create or replace function public.set_pick_qty(
  p_group_id    uuid,
  p_child_sku_id uuid,
  p_qty         integer,
  p_short       boolean default false
) returns jsonb
language plpgsql as $$
declare
  g          public.fulfillment_groups;
  v_required integer;
  v_qty      integer;
  v_uid      uuid := auth.uid();
  r          record;
begin
  select * into g from public.fulfillment_groups where id = p_group_id for update;
  if not found then raise exception 'set_pick_qty: group % not found', p_group_id; end if;
  if g.status <> 'open' then
    raise exception 'set_pick_qty: group % is % and is not being picked', p_group_id, g.status;
  end if;

  select required into v_required
    from public.pick_required(p_group_id)
   where child_sku_id = p_child_sku_id;
  if v_required is null then
    raise exception 'set_pick_qty: that SKU is not on any order still to pick in this group';
  end if;

  -- Clamp into [0, required]; you can't pick more than the orders ask for.
  v_qty := greatest(0, least(coalesce(p_qty, 0), v_required));

  insert into public.pick_progress
    (group_id, child_sku_id, qty_picked, short, picked_by, updated_at)
  values
    (p_group_id, p_child_sku_id, v_qty, coalesce(p_short, false), v_uid, now())
  on conflict (group_id, child_sku_id) do update
    set qty_picked = excluded.qty_picked,
        short      = excluded.short,
        picked_by  = excluded.picked_by,
        updated_at = now();

  -- First pick activity moves the group's brand-new orders onto the floor.
  if v_qty > 0 or coalesce(p_short, false) then
    for r in select id from public.orders
              where group_id = p_group_id and status = 'created'
    loop
      perform public.set_order_status(r.id, 'picking');
    end loop;
  end if;

  -- Heartbeat the claim if the caller holds it.
  update public.pick_claims
     set updated_at = now()
   where group_id = p_group_id and picked_by = v_uid;

  return jsonb_build_object(
    'child_sku_id', p_child_sku_id,
    'qty_picked',   v_qty,
    'required',     v_required,
    'short',        coalesce(p_short, false),
    'complete',     public.pick_complete(p_group_id));
end;
$$;

comment on function public.set_pick_qty(uuid, uuid, integer, boolean) is
  'Record picked quantity for a (group, child SKU), clamped to the required qty; p_short flags an out-of-stock line. First activity advances created orders to picking.';

-- ---------------------------------------------------------------------------
-- 6. Replace pack_group to GATE on picking completion.
--    Same behavior as 0012 otherwise: save the note, advance open orders to
--    'packed'. A group with orders still on the floor must finish picking first.
-- ---------------------------------------------------------------------------
create or replace function public.pack_group(
  p_group_id uuid, p_notes text default null
) returns public.fulfillment_groups
language plpgsql as $$
declare g public.fulfillment_groups; r record;
begin
  select * into g from public.fulfillment_groups where id = p_group_id for update;
  if not found then raise exception 'Group % not found', p_group_id; end if;
  if g.status <> 'open' then
    raise exception 'Group % is % and cannot be packed', p_group_id, g.status;
  end if;

  -- Gate: anything still on the floor must be fully picked (or marked short).
  if exists (select 1 from public.orders
              where group_id = p_group_id and status in ('created', 'picking'))
     and not public.pick_complete(p_group_id) then
    raise exception 'Finish picking this group before packing it'
      using errcode = 'P0001';
  end if;

  update public.fulfillment_groups
     set packing_notes = coalesce(p_notes, packing_notes)
   where id = p_group_id
   returning * into g;

  for r in
    select id from public.orders
     where group_id = p_group_id and status in ('created','picking')
  loop
    perform public.set_order_status(r.id, 'packed');
  end loop;

  return g;
end;
$$;

comment on function public.pack_group is
  'Save a group''s packing note and advance its open orders (created/picking) to packed. Gated: picking must be complete (every required SKU picked or marked short).';

commit;
