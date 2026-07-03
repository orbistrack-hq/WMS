-- ============================================================================
-- WMS — Migration 0031: weight-variant backfill (OrbisTrack, one-time cleanup)
--
-- Migration 0030 stops NEW splits. This consolidates the EXISTING split catalog:
-- products our sync flattened as "Strain - 3.5g" become weight-variant children
-- (grams_per_unit) under one canonical strain parent.
--
-- consolidate_weight_group re-parents the non-colliding children of the given
-- member products onto a canonical parent named p_strain, sets their weight, and
-- deactivates the emptied member products. It is a pure CATALOG reorg — it never
-- touches inventory counts. A "collision" (two members mapping to the same
-- site + weight, e.g. a "28g" and a "1oz") is NOT merged; it is skipped and
-- reported with its on-hand number so an operator can resolve it deliberately.
--
-- p_dry_run = true computes the same plan (moved count + collisions) without
-- writing, so the review screen can preview and the operator can "Confirm all".
--
-- Admin-gated and SECURITY DEFINER. Reverse with the matching down migration.
-- ============================================================================

begin;

create or replace function public.consolidate_weight_group(
  p_strain  text,
  p_members jsonb,               -- [{product_id uuid, grams numeric}]
  p_dry_run boolean default true
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_strain     text := nullif(btrim(coalesce(p_strain, '')), '');
  v_canonical  uuid;
  v_created    boolean := false;
  v_seen       text[] := '{}';
  v_moved      integer := 0;
  v_collisions jsonb := '[]'::jsonb;
  v_member     jsonb;
  v_mprod      uuid;
  v_mgrams     numeric;
  v_label      text;
  v_key        text;
  v_child      record;
  v_member_ids uuid[] := '{}';
begin
  if not public.is_admin() then
    raise exception 'consolidate_weight_group: admin only' using errcode = '42501';
  end if;
  if v_strain is null then
    raise exception 'consolidate_weight_group: strain is required';
  end if;
  if p_members is null or jsonb_typeof(p_members) <> 'array'
     or jsonb_array_length(p_members) = 0 then
    raise exception 'consolidate_weight_group: at least one member is required';
  end if;

  for v_member in select * from jsonb_array_elements(p_members) loop
    v_member_ids := array_append(v_member_ids, (v_member->>'product_id')::uuid);
  end loop;

  -- Canonical parent: an existing product named exactly p_strain that is NOT a
  -- member (prefer one that already holds weight children). Else create it.
  select p.id into v_canonical
    from public.products p
   where p.name = v_strain and not (p.id = any(v_member_ids))
   order by (exists (select 1 from public.child_skus c
                      where c.product_id = p.id and c.grams_per_unit is not null)) desc,
            p.created_at
   limit 1;
  if v_canonical is null then
    v_created := true;
    if not p_dry_run then
      insert into public.products(name) values (v_strain) returning id into v_canonical;
    end if;
  end if;

  -- Seed the seen-keys set from the canonical parent's existing children.
  if v_canonical is not null then
    select coalesce(
             array_agg(cs.site_id::text || '|' || coalesce(cs.grams_per_unit, -1)::text),
             '{}')
      into v_seen
      from public.child_skus cs
     where cs.product_id = v_canonical and cs.is_active;
  end if;

  for v_member in select * from jsonb_array_elements(p_members) loop
    v_mprod  := (v_member->>'product_id')::uuid;
    v_mgrams := (v_member->>'grams')::numeric;
    if v_mgrams is null or v_mgrams <= 0 then continue; end if;
    v_label := rtrim(rtrim(v_mgrams::text, '0'), '.') || 'g';

    for v_child in
      select cs.id, cs.site_id, s.name as site_name,
             coalesce(il.on_hand, 0) as on_hand
        from public.child_skus cs
        join public.sites s on s.id = cs.site_id
        left join public.inventory_levels il on il.child_sku_id = cs.id
       where cs.product_id = v_mprod and cs.is_active
    loop
      v_key := v_child.site_id::text || '|' || v_mgrams::text;
      if v_key = any(v_seen) then
        -- Collision: this site already has this weight. Skip + report numbers.
        v_collisions := v_collisions || jsonb_build_object(
          'site_id',   v_child.site_id,
          'site_name', v_child.site_name,
          'grams',     v_mgrams,
          'on_hand',   v_child.on_hand);
      else
        v_seen := array_append(v_seen, v_key);
        v_moved := v_moved + 1;
        if not p_dry_run then
          update public.child_skus
             set product_id = v_canonical, grams_per_unit = v_mgrams,
                 variant_label = coalesce(variant_label, v_label)
           where id = v_child.id;
        end if;
      end if;
    end loop;
  end loop;

  -- Deactivate member products whose children all moved (keeps history).
  if not p_dry_run then
    update public.products p
       set is_active = false
     where p.id = any(v_member_ids)
       and not exists (select 1 from public.child_skus c
                        where c.product_id = p.id and c.is_active);
  end if;

  return jsonb_build_object(
    'dry_run',           p_dry_run,
    'strain',            v_strain,
    'canonical_id',      v_canonical,
    'canonical_created', v_created,
    'moved',             v_moved,
    'collisions',        v_collisions);
end;
$$;

comment on function public.consolidate_weight_group is
  'Consolidate flattened "Strain - Xg" member products into weight-variant children under one strain parent. Re-parent only (no inventory change); collisions (same site+weight) are skipped and reported. p_dry_run previews. Admin only.';

grant execute on function public.consolidate_weight_group(text, jsonb, boolean)
  to authenticated;

commit;
