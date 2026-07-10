-- ============================================================================
-- WMS — Migration 0058: redeploy the SKU-identity conflict rule for merge_products
--
-- WHY THIS EXISTS (deployment fix, not a logic change).
-- Migration 0057 relaxed child uniqueness to SKU identity AND rewrote
-- merge_products so a conflict is only two UN-CODED (null-sku) children landing
-- on the same (site, weight) cell — letting coded "ounce special" children fold
-- cleanly onto their strain parent. Its index + sync changes reached production,
-- but its merge_products body did NOT: the function block was added to the 0057
-- file AFTER 20260709000057 was already recorded in the production migration
-- history, and `supabase db push` never re-runs an already-applied version. So
-- prod kept running the pre-0057 (0033/0039) function and the fulfillment team
-- still hit "resolve these site conflicts first — both products hold a SKU at
-- the same site (BC-BS-3.5G, BC-BS-OS)" when consolidating a strain's weights.
--
-- Editing 0057 again cannot fix prod (same reason: it's already recorded). This
-- NEW migration re-declares merge_products with the intended 0057 body so
-- `db push` carries it forward. In a clean from-scratch migrate the body is
-- identical to what 0057 already installed, so this is a harmless idempotent
-- re-declaration; on prod it is the correction. `create or replace` keeps the
-- signature, grants, and callers untouched.
--
-- Reverse with rollback/20260710000058_merge_products_sku_conflict_fix.down.sql.
-- ============================================================================

begin;

-- Conflict detection folded onto SKU identity: coded children are globally
-- unique per site by (site, sku) and never clash on a merge, so the only cell a
-- merge can still break is child_skus_null_variant_key — two UN-CODED (null-sku)
-- children at the same (site, weight). We flag only those. Auth + per-site
-- access are unchanged from the 0039 client-scoped version.
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
  select cs.site_id into v_bad_site
    from public.child_skus cs
   where (cs.product_id = p_survivor or cs.product_id = any(v_losers))
     and not public.can_access_site(cs.site_id)
   limit 1;
  if v_bad_site is not null then
    raise exception 'merge_products: you do not have access to every site involved'
      using errcode = '42501';
  end if;

  -- ---- conflict detection: only un-coded (null-sku) weight duplicates ------
  -- Coded children are globally unique per site by (site, sku), so they never
  -- clash on a merge. A genuine conflict is two null-sku children that would
  -- land on the same (site, weight) cell of the survivor.
  with involved as (
    select cs.site_id, cs.grams_per_unit,
           coalesce(cs.grams_per_unit, -1) as wkey
      from public.child_skus cs
     where (cs.product_id = p_survivor or cs.product_id = any(v_losers))
       and cs.sku is null
  ),
  clashes as (
    select site_id, wkey,
           max(grams_per_unit) as grams,
           count(*)            as n
      from involved
     group by site_id, wkey
    having count(*) > 1
  )
  select coalesce(
           jsonb_agg(jsonb_build_object(
             'site_id',   c.site_id,
             'site_name', s.name,
             'grams',     c.grams,
             'skus',      '[]'::jsonb)),
           '[]'::jsonb)
    into v_conflicts
    from clashes c
    join public.sites s on s.id = c.site_id;

  -- ---- stop here if there's a genuine un-coded (site, weight) collision -----
  if v_conflicts <> '[]'::jsonb then
    if p_dry_run then
      return jsonb_build_object(
        'ok', false, 'dry_run', true, 'survivor_id', p_survivor,
        'moved', 0, 'absorbed', '[]'::jsonb, 'conflicts', v_conflicts);
    end if;
    raise exception 'merge_products: un-coded (no-SKU) weight conflicts must be resolved first (%)',
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
  'Manual product merge: move loser products'' child SKUs onto a survivor, deactivate the emptied losers, and log it. Any signed-in user may call it, but must can_access_site() EVERY site involved (survivor + losers). Conflicts are only un-coded (null-sku) same-(site,weight) cells; coded children (unique per site by sku) fold cleanly, so ounce specials merge without a wall. Redeployed by migration 0058 (0057''s body was recorded but not applied to prod). p_dry_run previews without writing.';

commit;
