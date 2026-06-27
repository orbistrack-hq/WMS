-- ============================================================================
-- WMS — Migration 0022: manual product merge tool (part 3)
--
-- Migration 0020 stopped the sync from splitting catalogs; 0021 auto-merged the
-- duplicates it could reconcile by SKU and left genuinely ambiguous cases in
-- duplicate_products_report "for the manual merge tool (next step)". This is
-- that tool: an operator picks a surviving master and one or more products to
-- absorb into it, and this RPC moves their child SKUs across, deactivates the
-- emptied parents, and logs the merge.
--
-- It enforces the SAME one-child-per-site rule the schema does
-- (unique(product_id, site_id)): if the survivor and a loser both hold a child
-- at the same site, the move is ambiguous, so the whole merge is refused with a
-- listing of the conflicting sites. The operator resolves those (re-parent or
-- delete one side) and retries. A dry-run mode returns that same preview without
-- writing anything, so the UI can warn before committing.
--
-- Authorization: operators/admins only, and the caller must be able to access
-- every site whose child SKU would move (can_access_site). SECURITY DEFINER is
-- used only so the audit insert can reach product_merge_log (sealed in 0021);
-- the checks above are done explicitly inside the function.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Let product_merge_log record manual merges too.
--    Existing auto rows keep kind='auto'; manual rows have no single SKU.
-- ---------------------------------------------------------------------------
alter table public.product_merge_log alter column sku drop not null;
alter table public.product_merge_log
  add column if not exists kind text not null default 'auto'
  check (kind in ('auto', 'manual'));
alter table public.product_merge_log
  add column if not exists merged_by uuid references public.profiles(id);

-- ---------------------------------------------------------------------------
-- 2. The manual merge.
--    Returns jsonb:
--      { ok, dry_run, survivor_id, moved, absorbed:[uuid], conflicts:[{site_id, site_name, skus:[text]}] }
--    On a real (non-dry-run) call it RAISES if conflicts exist, so the catalog
--    is never left half-merged.
-- ---------------------------------------------------------------------------
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
  if not public.is_operator() then
    raise exception 'merge_products: not authorized';
  end if;

  -- ---- validate inputs ----------------------------------------------------
  if p_survivor is null then
    raise exception 'merge_products: survivor is required';
  end if;
  if p_losers is null or array_length(p_losers, 1) is null then
    raise exception 'merge_products: pick at least one product to merge in';
  end if;

  -- Distinct losers, never the survivor itself.
  select array_agg(distinct l) into v_losers
    from unnest(p_losers) as l
   where l is not null and l <> p_survivor;

  if v_losers is null or array_length(v_losers, 1) is null then
    raise exception 'merge_products: nothing to merge (only the survivor was given)';
  end if;

  -- Every id must be a real product.
  if (select count(*) from public.products p
       where p.id = p_survivor) = 0 then
    raise exception 'merge_products: survivor product not found';
  end if;
  if (select count(*) from public.products p
       where p.id = any(v_losers)) <> array_length(v_losers, 1) then
    raise exception 'merge_products: one or more products to merge no longer exist';
  end if;

  -- ---- site-access check: caller must own every site being moved ----------
  select cs.site_id into v_bad_site
    from public.child_skus cs
   where cs.product_id = any(v_losers)
     and not public.can_access_site(cs.site_id)
   limit 1;
  if v_bad_site is not null then
    raise exception 'merge_products: you do not have access to every site involved';
  end if;

  -- ---- conflict detection (one child per product per site) ---------------
  -- After the merge every site under the survivor must be unique. A conflict is
  -- any site held by more than one of {survivor + losers}.
  with involved as (
    select cs.id, cs.site_id, cs.sku
      from public.child_skus cs
     where cs.product_id = p_survivor or cs.product_id = any(v_losers)
  ),
  clashes as (
    select i.site_id, count(*) as n,
           array_remove(array_agg(i.sku order by i.sku), null) as skus
      from involved i
     group by i.site_id
    having count(*) > 1
  )
  select coalesce(
           jsonb_agg(jsonb_build_object(
             'site_id', c.site_id,
             'site_name', s.name,
             'skus', to_jsonb(c.skus))),
           '[]'::jsonb)
    into v_conflicts
    from clashes c
    join public.sites s on s.id = c.site_id;

  -- ---- stop here if there's anything ambiguous ---------------------------
  if v_conflicts <> '[]'::jsonb then
    if p_dry_run then
      return jsonb_build_object(
        'ok', false, 'dry_run', true, 'survivor_id', p_survivor,
        'moved', 0, 'absorbed', '[]'::jsonb, 'conflicts', v_conflicts);
    end if;
    raise exception 'merge_products: site conflicts must be resolved first (%)',
      v_conflicts using errcode = '23505';
  end if;

  -- ---- dry run: report what WOULD happen, change nothing ------------------
  if p_dry_run then
    select count(*) into v_moved
      from public.child_skus cs where cs.product_id = any(v_losers);
    return jsonb_build_object(
      'ok', true, 'dry_run', true, 'survivor_id', p_survivor,
      'moved', v_moved, 'absorbed', to_jsonb(v_losers),
      'conflicts', '[]'::jsonb);
  end if;

  -- ---- commit -------------------------------------------------------------
  with moved as (
    update public.child_skus cs
       set product_id = p_survivor
     where cs.product_id = any(v_losers)
    returning 1)
  select count(*) into v_moved from moved;

  -- Survivor must stay active; absorb its metadata-free.
  update public.products set is_active = true where id = p_survivor;

  -- Deactivate losers that are now childless (all of them, post-move).
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
    'moved', v_moved, 'absorbed', to_jsonb(v_absorbed),
    'conflicts', '[]'::jsonb);
end;
$$;

comment on function public.merge_products(uuid, uuid[], boolean) is
  'Manual product merge: move loser products'' child SKUs onto a survivor, deactivate the emptied losers, and log it. Operators/admins only; refuses ambiguous one-child-per-site conflicts; p_dry_run previews without writing.';

-- Operators call this from the app; the internal is_operator() gate is the real
-- guard. Keep it off anon.
grant execute on function public.merge_products(uuid, uuid[], boolean) to authenticated;
revoke execute on function public.merge_products(uuid, uuid[], boolean) from anon;

commit;
