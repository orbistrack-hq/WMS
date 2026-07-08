-- ============================================================================
-- Rollback 0042: restore the per-(product, site) parent pool.
--
-- Reinstates the post-0034 structure and the 0028/0029/0034 function bodies:
--   * parent_inventory regains site_id + the composite PK + site index;
--   * ledger/allocations.site_id back to NOT NULL; the central-only indexes drop;
--   * primitives/RPCs/reversals/view/policies revert to their site-scoped forms.
-- Collapsing balances in 0042 is one-way, so on real data (not a clean round-trip
-- on empty tables) the restored pools would need their site split re-entered.
-- ============================================================================

begin;

-- ---- drop the central objects ----------------------------------------------
drop view   if exists public.parent_inventory_report;
drop policy if exists parent_inventory_read        on public.parent_inventory;
drop policy if exists parent_inventory_ledger_read on public.parent_inventory_ledger;
drop policy if exists allocations_read             on public.allocations;
drop policy if exists allocation_lines_read        on public.allocation_lines;

drop function if exists public.intake_receive(uuid,numeric,text,text,text);
drop function if exists public.allocate_parent_stock(uuid,jsonb,text,text);
drop function if exists public._parent_inv_write(uuid,numeric,numeric,text,text,uuid,text,text);
drop function if exists public._parent_inv_lock(uuid);

drop index if exists public.parent_inventory_ledger_product_idx;
drop index if exists public.allocations_product_idx;

-- ---- restore the site dimension --------------------------------------------
alter table public.parent_inventory drop constraint parent_inventory_pkey;
alter table public.parent_inventory add column site_id uuid;
alter table public.parent_inventory
  add constraint parent_inventory_site_id_fkey
  foreign key (site_id) references public.sites(id) on delete cascade;
alter table public.parent_inventory alter column site_id set not null;
alter table public.parent_inventory add primary key (product_id, site_id);
create index if not exists parent_inventory_site_idx on public.parent_inventory(site_id);

alter table public.parent_inventory_ledger alter column site_id set not null;
alter table public.allocations             alter column site_id set not null;

-- ---- restore site-scoped primitives (0028 bodies) --------------------------
create or replace function public._parent_inv_lock(p_product uuid, p_site uuid)
returns public.parent_inventory language plpgsql as $$
declare v public.parent_inventory;
begin
  if p_product is null or p_site is null then
    raise exception '_parent_inv_lock: product and site are required';
  end if;
  insert into public.parent_inventory(product_id, site_id)
  values (p_product, p_site)
  on conflict (product_id, site_id) do nothing;

  select * into v from public.parent_inventory
   where product_id = p_product and site_id = p_site
   for update;
  return v;
end;
$$;

create or replace function public._parent_inv_write(
  p_product uuid, p_site uuid,
  p_delta_grams numeric, p_delta_allocated numeric,
  p_reason text, p_ref_type text, p_ref_id uuid, p_batch_no text, p_note text
) returns public.parent_inventory language plpgsql as $$
declare v public.parent_inventory;
begin
  update public.parent_inventory
     set on_hand_grams   = on_hand_grams   + p_delta_grams,
         allocated_grams = allocated_grams + coalesce(p_delta_allocated, 0),
         updated_at      = now()
   where product_id = p_product and site_id = p_site
   returning * into v;

  insert into public.parent_inventory_ledger(
    product_id, site_id, delta_grams, reason,
    reference_type, reference_id, batch_no, note, actor)
  values (p_product, p_site, p_delta_grams, p_reason,
    p_ref_type, p_ref_id, p_batch_no, p_note, auth.uid());

  return v;
end;
$$;

alter function public._parent_inv_lock(uuid,uuid) security definer set search_path = '';
alter function public._parent_inv_write(uuid,uuid,numeric,numeric,text,text,uuid,text,text)
  security definer set search_path = '';
revoke execute on function public._parent_inv_lock(uuid,uuid) from public;
revoke execute on function public._parent_inv_write(uuid,uuid,numeric,numeric,text,text,uuid,text,text) from public;

-- ---- restore intake_receive + allocate_parent_stock (0029 bodies) ----------
create or replace function public.intake_receive(
  p_product_id uuid, p_site_id uuid, p_qty numeric, p_uom text,
  p_batch_no text default null, p_note text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_grams numeric; v public.parent_inventory;
begin
  if p_product_id is null or p_site_id is null then
    raise exception 'intake_receive: product and site are required';
  end if;
  if not exists (select 1 from public.products where id = p_product_id) then
    raise exception 'intake_receive: product % not found', p_product_id;
  end if;
  if not exists (select 1 from public.sites where id = p_site_id) then
    raise exception 'intake_receive: site % not found', p_site_id;
  end if;
  v_grams := public.to_grams(p_qty, p_uom);
  if v_grams <= 0 then
    raise exception 'intake_receive: received quantity must be positive (got % %)', p_qty, p_uom
      using errcode = 'check_violation';
  end if;
  perform public._parent_inv_lock(p_product_id, p_site_id);
  v := public._parent_inv_write(
         p_product_id, p_site_id, v_grams, 0, 'intake', 'manual', null, p_batch_no, p_note);
  return jsonb_build_object(
    'product_id', p_product_id, 'site_id', p_site_id,
    'received_grams', v_grams, 'on_hand_grams', v.on_hand_grams);
end;
$$;

create or replace function public.allocate_parent_stock(
  p_product_id uuid, p_site_id uuid, p_lines jsonb,
  p_idempotency_key text default null, p_note text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_parent public.parent_inventory; v_line jsonb; v_child_id uuid; v_units integer;
  v_gpu numeric; v_child_prod uuid; v_total numeric := 0; v_alloc_id uuid; v_child_count integer := 0;
begin
  if p_product_id is null or p_site_id is null then
    raise exception 'allocate_parent_stock: product and site are required';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'allocate_parent_stock: at least one allocation line is required';
  end if;
  if p_idempotency_key is not null then
    select id into v_alloc_id from public.allocations where idempotency_key = p_idempotency_key;
    if found then
      return jsonb_build_object(
        'allocation_id', v_alloc_id, 'product_id', p_product_id, 'site_id', p_site_id,
        'total_grams', (select total_grams from public.allocations where id = v_alloc_id),
        'remaining_grams', (select on_hand_grams from public.parent_inventory where product_id = p_product_id and site_id = p_site_id),
        'child_count', (select count(*)::int from public.allocation_lines where allocation_id = v_alloc_id),
        'replayed', true);
    end if;
  end if;
  v_parent := public._parent_inv_lock(p_product_id, p_site_id);
  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_child_id := (v_line->>'child_sku_id')::uuid;
    v_units := coalesce((v_line->>'units')::integer, 0);
    if v_child_id is null then raise exception 'allocate_parent_stock: line missing child_sku_id'; end if;
    if v_units < 0 then raise exception 'allocate_parent_stock: units cannot be negative (child %)', v_child_id; end if;
    continue when v_units = 0;
    select product_id, grams_per_unit into v_child_prod, v_gpu from public.child_skus where id = v_child_id;
    if v_child_prod is null then raise exception 'allocate_parent_stock: child SKU % not found', v_child_id; end if;
    if v_child_prod <> p_product_id then
      raise exception 'allocate_parent_stock: child SKU % does not belong to parent %', v_child_id, p_product_id; end if;
    if v_gpu is null then
      raise exception 'allocate_parent_stock: child SKU % has no grams_per_unit; cannot allocate by grams', v_child_id; end if;
    v_total := v_total + (v_units * v_gpu);
  end loop;
  if v_total <= 0 then raise exception 'allocate_parent_stock: nothing to allocate (all lines zero)'; end if;
  if v_total > v_parent.on_hand_grams then
    raise exception 'Total allocated inventory exceeds available Parent SKU inventory.' using errcode = 'check_violation'; end if;
  begin
    insert into public.allocations (product_id, site_id, total_grams, note, idempotency_key, actor)
    values (p_product_id, p_site_id, v_total, p_note, p_idempotency_key, auth.uid())
    returning id into v_alloc_id;
  exception when unique_violation then
    select id into v_alloc_id from public.allocations where idempotency_key = p_idempotency_key;
    return jsonb_build_object(
      'allocation_id', v_alloc_id, 'product_id', p_product_id, 'site_id', p_site_id,
      'total_grams', (select total_grams from public.allocations where id = v_alloc_id),
      'remaining_grams', v_parent.on_hand_grams,
      'child_count', (select count(*)::int from public.allocation_lines where allocation_id = v_alloc_id),
      'replayed', true);
  end;
  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_child_id := (v_line->>'child_sku_id')::uuid;
    v_units := coalesce((v_line->>'units')::integer, 0);
    continue when v_units = 0;
    select grams_per_unit into v_gpu from public.child_skus where id = v_child_id;
    insert into public.allocation_lines (allocation_id, child_sku_id, units, grams_per_unit, grams)
    values (v_alloc_id, v_child_id, v_units, v_gpu, v_units * v_gpu);
    perform public.receive_stock(v_child_id, v_units, 'allocation', v_alloc_id, 'allocation');
    v_child_count := v_child_count + 1;
  end loop;
  v_parent := public._parent_inv_write(
                p_product_id, p_site_id, -v_total, v_total, 'allocation', 'allocation', v_alloc_id, null, p_note);
  return jsonb_build_object(
    'allocation_id', v_alloc_id, 'product_id', p_product_id, 'site_id', p_site_id,
    'total_grams', v_total, 'remaining_grams', v_parent.on_hand_grams,
    'child_count', v_child_count, 'replayed', false);
end;
$$;

revoke execute on function public.intake_receive(uuid,uuid,numeric,text,text,text) from public;
revoke execute on function public.allocate_parent_stock(uuid,uuid,jsonb,text,text) from public;
grant  execute on function public.intake_receive(uuid,uuid,numeric,text,text,text) to authenticated;
grant  execute on function public.allocate_parent_stock(uuid,uuid,jsonb,text,text) to authenticated;

-- ---- restore reversals (0034 site bodies) ----------------------------------
create or replace function public.reverse_intake(p_ledger_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare L public.parent_inventory_ledger; v public.parent_inventory;
begin
  if public.app_role() not in ('admin','operator') then
    raise exception 'Not authorized to reverse an intake' using errcode = '42501'; end if;
  select * into L from public.parent_inventory_ledger where id = p_ledger_id for update;
  if L.id is null then raise exception 'Intake entry % not found', p_ledger_id; end if;
  if L.reason <> 'intake' then
    raise exception 'Ledger entry % is not an intake (it is %); only intakes can be reversed here', p_ledger_id, L.reason; end if;
  if L.reversed_at is not null then raise exception 'This intake was already reversed on %', L.reversed_at; end if;
  v := public._parent_inv_lock(L.product_id, L.site_id);
  if v.on_hand_grams < L.delta_grams then
    raise exception 'Cannot reverse: only % g remain on hand but this intake added % g — the rest is already allocated.',
      v.on_hand_grams, L.delta_grams using errcode = 'check_violation'; end if;
  v := public._parent_inv_write(L.product_id, L.site_id, -L.delta_grams, 0,
         'correction', 'intake_reversal', L.id, L.batch_no, 'Reversal of intake ' || L.id::text);
  update public.parent_inventory_ledger set reversed_at = now(), reversed_by = auth.uid() where id = L.id;
  return jsonb_build_object('reversed_ledger_id', L.id, 'product_id', L.product_id, 'site_id', L.site_id,
    'removed_grams', L.delta_grams, 'on_hand_grams', v.on_hand_grams);
end;
$$;

create or replace function public.reverse_allocation(p_allocation_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare A public.allocations; ln record; il public.inventory_levels; v_block text := '';
  v_parent public.parent_inventory; v_count integer := 0;
begin
  if public.app_role() not in ('admin','operator') then
    raise exception 'Not authorized to reverse an allocation' using errcode = '42501'; end if;
  select * into A from public.allocations where id = p_allocation_id for update;
  if A.id is null then raise exception 'Allocation % not found', p_allocation_id; end if;
  if A.reversed_at is not null then raise exception 'This allocation was already reversed on %', A.reversed_at; end if;
  v_parent := public._parent_inv_lock(A.product_id, A.site_id);
  for ln in select al.child_sku_id, al.units, cs.sku from public.allocation_lines al
    join public.child_skus cs on cs.id = al.child_sku_id where al.allocation_id = A.id loop
    il := public._inv_lock(ln.child_sku_id);
    if il.on_hand < ln.units or (il.on_hand - ln.units) < il.reserved then
      v_block := v_block || format(E'\n  - %s: %s allocated, but only %s free to reverse (%s on hand, %s reserved).',
        coalesce(ln.sku, '(no SKU)'), ln.units, greatest(il.on_hand - il.reserved, 0), il.on_hand, il.reserved);
    end if;
  end loop;
  if length(v_block) > 0 then
    raise exception 'Cannot reverse allocation - some units are already reserved or sold:%', v_block using errcode = 'check_violation'; end if;
  for ln in select al.child_sku_id, al.units from public.allocation_lines al where al.allocation_id = A.id loop
    perform public._inv_write(ln.child_sku_id, -ln.units, 0, 0,
      'correction', 'allocation_reversal', A.id, 'Reversal of allocation ' || A.id::text);
    v_count := v_count + 1;
  end loop;
  v_parent := public._parent_inv_write(A.product_id, A.site_id, A.total_grams, -A.total_grams,
                'correction', 'allocation_reversal', A.id, null, 'Reversal of allocation ' || A.id::text);
  update public.allocations set reversed_at = now(), reversed_by = auth.uid() where id = A.id;
  return jsonb_build_object('reversed_allocation_id', A.id, 'product_id', A.product_id, 'site_id', A.site_id,
    'restored_grams', A.total_grams, 'children_reversed', v_count, 'on_hand_grams', v_parent.on_hand_grams);
end;
$$;

revoke execute on function public.reverse_intake(uuid) from public;
revoke execute on function public.reverse_allocation(uuid) from public;
grant  execute on function public.reverse_intake(uuid) to authenticated;
grant  execute on function public.reverse_allocation(uuid) to authenticated;

-- ---- restore site-scoped RLS + report view ---------------------------------
create policy parent_inventory_read on public.parent_inventory
  for select using (public.can_access_site(site_id));
create policy parent_inventory_ledger_read on public.parent_inventory_ledger
  for select using (public.can_access_site(site_id));
create policy allocations_read on public.allocations
  for select using (public.can_access_site(site_id));
create policy allocation_lines_read on public.allocation_lines
  for select using (exists (
    select 1 from public.allocations a
     where a.id = allocation_lines.allocation_id
       and public.can_access_site(a.site_id)));

create view public.parent_inventory_report with (security_invoker = true) as
select pi.product_id, p.name as product_name, pi.site_id, s.name as site_name,
       pi.on_hand_grams as available_grams, pi.allocated_grams, pi.updated_at
from public.parent_inventory pi
join public.products p on p.id = pi.product_id
join public.sites    s on s.id = pi.site_id;
grant select on public.parent_inventory_report to authenticated;

commit;
