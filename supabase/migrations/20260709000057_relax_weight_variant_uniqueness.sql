-- ============================================================================
-- WMS — Migration 0057: relax weight-variant uniqueness to SKU identity
--
-- Background. Migration 0028 replaced the old "one child per (product, site)"
-- rule with a unique index on (product_id, site_id, coalesce(grams_per_unit,-1))
-- so a strain parent could hold one child per weight per site (3.5/7/14/28g).
-- That was right for distinct weights, but it also caps a site at exactly ONE
-- child of any given weight. A second 28g child of the same strain — an "ounce
-- special": same weight, but its own SKU and price — is therefore refused with a
-- unique-violation. The fulfillment team hits this when merging an ounce special
-- onto a ZOAP parent that already carries a 28g child.
--
-- Fix. Uniqueness for CODED children already rests on child_skus_site_sku_key
-- (site_id, sku) WHERE sku IS NOT NULL — a SKU is unique across the whole site,
-- a STRONGER guarantee than the weight index. So we drop the weight index and
-- let the SKU be the identity, exactly as requested. To keep the one guard the
-- weight index still earned — blocking SILENT duplicates among children that
-- carry NO sku code (the store-sync fallback deliberately inserts a null sku on
-- a code clash) — we add a PARTIAL unique index over the same key but only
-- WHERE sku IS NULL. Net:
--   * coded children   -> unique per site by (site, sku): many weights, and now
--                         many children per weight, all distinguished by SKU.
--   * un-coded children -> at most one per (product, site, weight), as before.
-- A silent duplicate is impossible on either path.
--
-- Sync adoption. upsert_store_weight_variant (0030) adopted "any child at this
-- (product, site, weight)" when a NEW store variant arrived. With two same-weight
-- children now legal, that could hijack a manual ounce special. We tighten it to
-- adopt only an UNMAPPED child (store_variant_id IS NULL) with an EXACT SKU
-- match; a new variant with no sku twin inserts its own child rather than guess.
-- Re-syncs still match by store_variant_id first (step 1), so existing mappings
-- are untouched and tests 21/22 are unaffected.
--
-- Reverse with rollback/20260709000057_relax_weight_variant_uniqueness.down.sql.
-- ============================================================================

begin;

-- ---- 1. Uniqueness: SKU replaces weight as the child identity ---------------
-- Drop the weight index; child_skus_site_sku_key (site, sku) now carries coded
-- uniqueness. Add a partial index so un-coded children still can't silently
-- duplicate a (product, site, weight) cell.
drop index if exists public.child_skus_product_site_variant_key;

create unique index if not exists child_skus_null_variant_key
  on public.child_skus (product_id, site_id, coalesce(grams_per_unit, -1))
  where sku is null;

comment on index public.child_skus_null_variant_key is
  'Blocks silent duplicates among un-coded children: at most one child with a NULL sku per (product, site, weight). Coded children are kept unique per site by child_skus_site_sku_key, so several same-weight coded variants (e.g. two 28g "ounce specials") may coexist. Replaces child_skus_product_site_variant_key (migration 0057).';

-- ---- 2. Store sync: don't let a new store variant hijack a same-weight child -
create or replace function public.upsert_store_weight_variant(
  p_site_id          uuid,
  p_store_variant_id text,
  p_strain_name      text,       -- the parent strain (store product title)
  p_grams_per_unit   numeric,    -- parsed weight, must be > 0
  p_sku              text default null,
  p_price            numeric default 0,
  p_cost             numeric default null,
  p_inventory_qty    integer default null,
  p_channel          text default 'manual'
) returns table(child_sku_id uuid, created boolean, cost_seeded boolean)
language plpgsql as $$
declare
  v_child   uuid;
  v_product uuid;
  v_cost    numeric;
  v_sku     text    := nullif(btrim(coalesce(p_sku, '')), '');
  v_price   numeric := coalesce(p_price, 0);
  v_name    text    := nullif(btrim(coalesce(p_strain_name, '')), '');
  v_created boolean := false;
  v_seeded  boolean := false;
  v_label   text;
begin
  if p_site_id is null
     or nullif(btrim(coalesce(p_store_variant_id, '')), '') is null then
    raise exception 'upsert_store_weight_variant: site and store_variant_id are required';
  end if;
  if p_grams_per_unit is null or p_grams_per_unit <= 0 then
    raise exception 'upsert_store_weight_variant: grams_per_unit must be positive';
  end if;
  if v_name is null then
    raise exception 'upsert_store_weight_variant: strain name is required';
  end if;

  -- Label like "3.5g" / "28g" (strip trailing zeros).
  v_label := rtrim(rtrim(p_grams_per_unit::text, '0'), '.') || 'g';

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
             grams_per_unit = p_grams_per_unit,
             variant_label  = coalesce(variant_label, v_label),
             cost = case when v_seeded then p_cost else cost end
       where id = v_child;
    exception when unique_violation then
      -- SKU collides with another child at this site; keep the mapping, drop sku.
      update public.child_skus
         set sku = null, price = v_price, is_active = true,
             grams_per_unit = p_grams_per_unit,
             variant_label  = coalesce(variant_label, v_label),
             cost = case when v_seeded then p_cost else cost end
       where id = v_child;
    end;
    update public.products set name = v_name, is_active = true where id = v_product;
    v_created := false;
  else

  -- 2. Resolve the shared strain parent: an existing product with this exact
  --    name that already holds a weight child (any site). Else create it.
  select p.id into v_product
    from public.products p
   where p.name = v_name
     and exists (
       select 1 from public.child_skus c
        where c.product_id = p.id and c.grams_per_unit is not null)
   order by p.created_at
   limit 1;
  if v_product is null then
    insert into public.products(name) values (v_name) returning id into v_product;
  end if;

  v_seeded := (p_cost is not null);

  -- 3. Adopt an UNMAPPED child at this (product, site, weight) ONLY on an exact
  --    SKU match — otherwise insert a fresh child. Two same-weight children can
  --    now coexist (0057), so weight alone is no longer a unique key; adopting on
  --    weight could stamp this store variant onto a manual "ounce special". A new
  --    variant with no sku twin therefore creates its own child (visible and
  --    mergeable) rather than silently taking over an existing one.
  v_child := null;
  if v_sku is not null then
    select cs.id into v_child
      from public.child_skus cs
     where cs.product_id = v_product and cs.site_id = p_site_id
       and cs.grams_per_unit = p_grams_per_unit
       and cs.store_variant_id is null
       and cs.sku = v_sku
     limit 1;
  end if;

  if v_child is not null then
    begin
      update public.child_skus
         set store_variant_id = p_store_variant_id, sku = v_sku, price = v_price,
             is_active = true, variant_label = coalesce(variant_label, v_label),
             cost = case when v_seeded and coalesce(cost, 0) = 0 then p_cost else cost end
       where id = v_child;
    exception when unique_violation then
      update public.child_skus
         set store_variant_id = p_store_variant_id, sku = null, price = v_price,
             is_active = true, variant_label = coalesce(variant_label, v_label),
             cost = case when v_seeded and coalesce(cost, 0) = 0 then p_cost else cost end
       where id = v_child;
    end;
    v_created := false;
  else
    begin
      insert into public.child_skus
        (product_id, site_id, sku, store_variant_id, grams_per_unit, variant_label, price, cost)
      values
        (v_product, p_site_id, v_sku, p_store_variant_id, p_grams_per_unit, v_label,
         v_price, coalesce(p_cost, 0))
      returning id into v_child;
    exception when unique_violation then
      -- SKU collision at this site -> insert without the sku code.
      insert into public.child_skus
        (product_id, site_id, sku, store_variant_id, grams_per_unit, variant_label, price, cost)
      values
        (v_product, p_site_id, null, p_store_variant_id, p_grams_per_unit, v_label,
         v_price, coalesce(p_cost, 0))
      returning id into v_child;
    end;
    v_created := true;
  end if;
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

comment on function public.upsert_store_weight_variant is
  'Map one store variant recognized as a weight (grams_per_unit) to a shared strain parent + weight-variant child SKU. Groups weights across clients by exact strain name. Store owns name/price/sku; cost is seed-only; on_hand syncs via set_on_hand_to. Since 0057, adopts only an unmapped same-weight child on an EXACT sku match, else inserts, so a new store variant cannot hijack a manual same-weight variant.';

-- ---- 3. merge_products: fold the conflict rule onto SKU identity too --------
-- This is the path the fulfillment team actually hits: merging an "ounce
-- special" product into the main strain parent. merge_products (0033/0039) still
-- refused ANY (site, weight) cell held by >1 child, so an ounce special (a 28g
-- child) would clash with the parent's existing 28g child and the merge was
-- blocked — the same wall, one layer up from the index.
--
-- Post-0057 the child identity is the SKU. child_skus_site_sku_key makes
-- (site, sku) unique across ALL products, so two CODED children can never
-- collide by a merge — an ounce special folds cleanly onto a parent that already
-- holds that weight. The only cell a merge can still break is
-- child_skus_null_variant_key: two UN-CODED (null-sku) children at the same
-- (site, weight). We flag only those. Body is otherwise the 0039 client-scoped
-- version (auth + per-site access unchanged).
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
  'Manual product merge: move loser products'' child SKUs onto a survivor, deactivate the emptied losers, and log it. Any signed-in user may call it, but must can_access_site() EVERY site involved (survivor + losers). Since 0057, conflicts are only un-coded (null-sku) same-(site,weight) cells; coded children (unique per site by sku) fold cleanly, so ounce specials merge without a wall. p_dry_run previews without writing.';

commit;
