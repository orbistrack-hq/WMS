-- ============================================================================
-- WMS — Migration 0039: client-scoped packaging types + client-usable merge
--
-- This is the first migration that lets CLIENT-side users (not just our internal
-- admin/operator team) self-serve two catalog chores, each scoped to the sites
-- they're actually assigned. The WMS is moving from internal-only to external
-- clientele, so "who can touch this, and only for their own site" now matters.
--
-- 1. Packaging types become site-scoped.
--    packaging_types was a single global list, admin-only to edit. We add a
--    NULLABLE site_id:
--      * site_id IS NULL  -> a SHARED default (Standard Box, Shipping Label, …)
--                            that every site sees and only an ADMIN can change.
--      * site_id = <site>  -> OWNED by that site; anyone who can_access_site() it
--                            (its client, plus operators) may add/edit/delete it.
--    Reads: a user sees the shared defaults plus the owned types of any site they
--    can access. One client never sees, nor can edit, another client's types.
--    Keeping shared defaults NULL avoids duplicating box/label per site and keeps
--    the packing screen's default-packaging logic untouched.
--
-- 2. Packaging STOCK writers get the site guard they were missing.
--    receive/adjust/set_reorder are SECURITY DEFINER and were written when only
--    all-site operators reached the settings screen, so they never checked
--    can_access_site — harmless then, a privilege gap the moment a client can
--    open the page. We add the guard, plus a consistency rule: a site-owned
--    packaging type may only hold stock at its own site.
--
-- 3. merge_products becomes callable by clients, still safely scoped.
--    The RPC was gated to operators (is_operator). We drop that gate and instead
--    require the caller can_access_site() EVERY site involved — now the survivor
--    AND the losers (previously only losers were checked, which was fine only
--    because operators see all sites). A client can consolidate duplicate masters
--    entirely within their own sites; a merge that would touch another tenant's
--    site is refused. The weight-aware conflict rule (0033) is unchanged.
--
-- Reverse with rollback/20260707000039_client_scoped_packaging_and_merge.down.sql.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. packaging_types.site_id + scoped RLS
-- ----------------------------------------------------------------------------
alter table public.packaging_types
  add column site_id uuid references public.sites(id) on delete cascade;

-- Partial index: only owned rows carry a site; shared rows stay NULL.
create index packaging_types_site_idx
  on public.packaging_types(site_id) where site_id is not null;

comment on column public.packaging_types.site_id is
  'NULL = shared default (admin-managed, visible to all sites). Non-NULL = owned by that site; managed by anyone who can_access_site() it.';

-- Replace the two Phase-A policies (packaging_types_read: any authenticated;
-- packaging_types_admin: is_admin for all) with site-aware ones.
drop policy if exists packaging_types_read  on public.packaging_types;
drop policy if exists packaging_types_admin on public.packaging_types;

-- Read: shared defaults are visible to everyone signed in; owned types only to
-- users who can access that site (operators can access all).
create policy packaging_types_read on public.packaging_types for select
  using (
    auth.uid() is not null
    and (site_id is null or public.can_access_site(site_id))
  );

-- Write: admins manage anything, including the shared (NULL) defaults. Everyone
-- else may only manage OWNED types at a site they can access — never a shared
-- default, and never another site's type. The with_check on update also blocks
-- re-homing a type to NULL or to an inaccessible site.
create policy packaging_types_insert on public.packaging_types for insert
  with check (
    public.is_admin()
    or (site_id is not null and public.can_access_site(site_id))
  );
create policy packaging_types_update on public.packaging_types for update
  using (
    public.is_admin()
    or (site_id is not null and public.can_access_site(site_id))
  )
  with check (
    public.is_admin()
    or (site_id is not null and public.can_access_site(site_id))
  );
create policy packaging_types_delete on public.packaging_types for delete
  using (
    public.is_admin()
    or (site_id is not null and public.can_access_site(site_id))
  );

-- ----------------------------------------------------------------------------
-- 2. Packaging stock writers: add the site-access guard + type/site consistency.
--    Bodies are the 0025 originals with two checks prepended; kept SECURITY
--    DEFINER with an empty search_path so every reference stays schema-qualified.
-- ----------------------------------------------------------------------------
create or replace function public.receive_packaging(
  p_type uuid, p_site uuid, p_qty integer, p_note text default null
) returns public.packaging_levels
language plpgsql security definer set search_path = '' as $$
begin
  if not public.can_access_site(p_site) then
    raise exception 'receive_packaging: not authorized for this site'
      using errcode = '42501';
  end if;
  if exists (select 1 from public.packaging_types t
              where t.id = p_type and t.site_id is not null and t.site_id <> p_site) then
    raise exception 'receive_packaging: this packaging type belongs to another site'
      using errcode = 'check_violation';
  end if;
  if p_qty is null or p_qty <= 0 then
    raise exception 'receive_packaging: quantity must be positive (got %)', p_qty
      using errcode = 'check_violation';
  end if;
  perform public._pkg_lock(p_type, p_site);
  return public._pkg_write(p_type, p_site, p_qty, 'receipt', 'manual', null, p_note);
end;
$$;

create or replace function public.adjust_packaging(
  p_type uuid, p_site uuid, p_delta integer, p_note text
) returns public.packaging_levels
language plpgsql security definer set search_path = '' as $$
declare v public.packaging_levels;
begin
  if not public.can_access_site(p_site) then
    raise exception 'adjust_packaging: not authorized for this site'
      using errcode = '42501';
  end if;
  if exists (select 1 from public.packaging_types t
              where t.id = p_type and t.site_id is not null and t.site_id <> p_site) then
    raise exception 'adjust_packaging: this packaging type belongs to another site'
      using errcode = 'check_violation';
  end if;
  if p_delta = 0 then
    raise exception 'adjust_packaging: delta must be non-zero';
  end if;
  if p_note is null or length(trim(p_note)) = 0 then
    raise exception 'adjust_packaging: a note is required';
  end if;
  v := public._pkg_lock(p_type, p_site);
  if v.on_hand + p_delta < 0 then
    raise exception 'Adjustment would make packaging on_hand negative: on_hand %, delta %',
      v.on_hand, p_delta using errcode = 'check_violation';
  end if;
  return public._pkg_write(p_type, p_site, p_delta, 'manual_adjustment', 'manual', null, p_note);
end;
$$;

create or replace function public.set_packaging_reorder_point(
  p_type uuid, p_site uuid, p_point integer
) returns public.packaging_levels
language plpgsql security definer set search_path = '' as $$
declare v public.packaging_levels;
begin
  if not public.can_access_site(p_site) then
    raise exception 'set_packaging_reorder_point: not authorized for this site'
      using errcode = '42501';
  end if;
  if exists (select 1 from public.packaging_types t
              where t.id = p_type and t.site_id is not null and t.site_id <> p_site) then
    raise exception 'set_packaging_reorder_point: this packaging type belongs to another site'
      using errcode = 'check_violation';
  end if;
  if p_point is not null and p_point < 0 then
    raise exception 'set_packaging_reorder_point: reorder point cannot be negative';
  end if;
  perform public._pkg_lock(p_type, p_site);
  update public.packaging_levels
     set reorder_point = p_point, updated_at = now()
   where packaging_type_id = p_type and site_id = p_site
   returning * into v;
  return v;
end;
$$;

-- ----------------------------------------------------------------------------
-- 3. merge_products: allow clients; require access to EVERY involved site
--    (survivor + losers). Otherwise identical to the weight-aware 0033 body.
-- ----------------------------------------------------------------------------
create or replace function public.merge_products(
  p_survivor uuid,
  p_losers   uuid[],
  p_dry_run  boolean default false
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_losers     uuid[];
  v_conflicts  jsonb;
  v_moved      integer := 0;
  v_absorbed   uuid[];
  v_bad_site   uuid;
begin
  -- ---- authorization ------------------------------------------------------
  -- No role gate: any signed-in user may merge, but the site-access check below
  -- is the real guard — the caller must own every site involved. Clients can
  -- thus consolidate their own duplicate masters without an operator.
  if auth.uid() is null then
    raise exception 'merge_products: not authenticated';
  end if;

  -- ---- validate inputs ----------------------------------------------------
  if p_survivor is null then
    raise exception 'merge_products: survivor is required';
  end if;
  if p_losers is null or array_length(p_losers, 1) is null then
    raise exception 'merge_products: pick at least one product to merge in';
  end if;

  select array_agg(distinct l) into v_losers
    from unnest(p_losers) as l
   where l is not null and l <> p_survivor;

  if v_losers is null or array_length(v_losers, 1) is null then
    raise exception 'merge_products: nothing to merge (only the survivor was given)';
  end if;

  if (select count(*) from public.products p where p.id = p_survivor) = 0 then
    raise exception 'merge_products: survivor product not found';
  end if;
  if (select count(*) from public.products p where p.id = any(v_losers))
       <> array_length(v_losers, 1) then
    raise exception 'merge_products: one or more products to merge no longer exist';
  end if;

  -- ---- site-access check: caller must own every site involved --------------
  -- Now covers the SURVIVOR's children as well as the losers'. Previously only
  -- losers were checked, which was safe only because operators see all sites; a
  -- client must not be able to fold a duplicate into a master that also lives at
  -- a site they can't access.
  select cs.site_id into v_bad_site
    from public.child_skus cs
   where (cs.product_id = p_survivor or cs.product_id = any(v_losers))
     and not public.can_access_site(cs.site_id)
   limit 1;
  if v_bad_site is not null then
    raise exception 'merge_products: you do not have access to every site involved'
      using errcode = '42501';
  end if;

  -- ---- conflict detection (one child per product per site PER WEIGHT) -----
  with involved as (
    select cs.site_id, cs.sku, cs.grams_per_unit,
           coalesce(cs.grams_per_unit, -1) as wkey
      from public.child_skus cs
     where cs.product_id = p_survivor or cs.product_id = any(v_losers)
  ),
  clashes as (
    select site_id, wkey,
           max(grams_per_unit)                         as grams,
           count(*)                                    as n,
           array_remove(array_agg(sku order by sku), null) as skus
      from involved
     group by site_id, wkey
    having count(*) > 1
  )
  select coalesce(
           jsonb_agg(jsonb_build_object(
             'site_id',   c.site_id,
             'site_name', s.name,
             'grams',     c.grams,
             'skus',      to_jsonb(c.skus))),
           '[]'::jsonb)
    into v_conflicts
    from clashes c
    join public.sites s on s.id = c.site_id;

  -- ---- stop here if there's a genuine (site, weight) collision -------------
  if v_conflicts <> '[]'::jsonb then
    if p_dry_run then
      return jsonb_build_object(
        'ok', false, 'dry_run', true, 'survivor_id', p_survivor,
        'moved', 0, 'absorbed', '[]'::jsonb, 'conflicts', v_conflicts);
    end if;
    raise exception 'merge_products: site/weight conflicts must be resolved first (%)',
      v_conflicts using errcode = '23505';
  end if;

  -- ---- dry run: report what WOULD happen, change nothing ------------------
  if p_dry_run then
    select count(*) into v_moved
      from public.child_skus cs where cs.product_id = any(v_losers);
    return jsonb_build_object(
      'ok', true, 'dry_run', true, 'survivor_id', p_survivor,
      'moved', v_moved, 'absorbed', to_jsonb(v_losers), 'conflicts', '[]'::jsonb);
  end if;

  -- ---- commit -------------------------------------------------------------
  with moved as (
    update public.child_skus cs
       set product_id = p_survivor
     where cs.product_id = any(v_losers)
    returning 1)
  select count(*) into v_moved from moved;

  update public.products set is_active = true where id = p_survivor;

  with emptied as (
    update public.products p
       set is_active = false
     where p.id = any(v_losers)
       and not exists (
         select 1 from public.child_skus c where c.product_id = p.id)
    returning p.id)
  select coalesce(array_agg(id), '{}'::uuid[]) into v_absorbed from emptied;

  insert into public.product_merge_log
    (sku, survivor_product_id, absorbed_product_ids, kind, merged_by)
  values (null, p_survivor, v_absorbed, 'manual', auth.uid());

  return jsonb_build_object(
    'ok', true, 'dry_run', false, 'survivor_id', p_survivor,
    'moved', v_moved, 'absorbed', to_jsonb(v_absorbed), 'conflicts', '[]'::jsonb);
end;
$$;

comment on function public.merge_products(uuid, uuid[], boolean) is
  'Manual product merge: move loser products'' child SKUs onto a survivor, deactivate the emptied losers, and log it. Any signed-in user may call it, but must can_access_site() EVERY site involved (survivor + losers). Weight-variant aware (0033); p_dry_run previews without writing.';

commit;
