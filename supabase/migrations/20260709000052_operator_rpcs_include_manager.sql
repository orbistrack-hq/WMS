-- ============================================================================
-- WMS — Migration 0052: operator-level RPCs recognise the manager role
--
-- Migration 0050 made `manager` an operator-level role by adding it to
-- is_operator(). But several operator-level RPCs predate the manager role and
-- hardcode their own guard — `app_role() not in ('admin','operator')` — instead
-- of calling is_operator(). Those functions therefore silently reject managers,
-- which is why a manager couldn't reverse an intake / allocation / shake or
-- receive/adjust central packaging stock.
--
-- This migration recreates those six functions with the guard rewritten to
-- `not public.is_operator()`, so they track the role set centrally from now on
-- (any future role added to is_operator() is covered automatically). Bodies are
-- otherwise IDENTICAL to their current definitions (reverse_intake /
-- reverse_allocation from 0043, reverse_shake from 0044, the three packaging
-- writers from 0048). No signatures change, so existing GRANTs are preserved.
--
-- No UI changes are needed: the reversal buttons are ungated (the RPC is the
-- guard) and inventory/packaging/page.tsx already gates its controls on
-- is_operator(). This is purely the server-side authorization catching up.
--
-- Scope note: this grants managers OPERATOR-level parity only. Admin-only
-- operations (hard catalog/order deletes, site + packaging-TYPE config) are
-- intentionally left untouched — operators don't have those either.
-- ============================================================================

begin;

-- ---- Reversals on the central parent pool (current defs from 0043) ----------

create or replace function public.reverse_intake(p_ledger_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  L public.parent_inventory_ledger;
  v public.parent_inventory;
begin
  if not public.is_operator() then
    raise exception 'Not authorized to reverse an intake' using errcode = '42501';
  end if;

  select * into L from public.parent_inventory_ledger where id = p_ledger_id for update;
  if L.id is null then
    raise exception 'Intake entry % not found', p_ledger_id;
  end if;
  if L.reason <> 'intake' then
    raise exception 'Ledger entry % is not an intake (it is %); only intakes can be reversed here',
      p_ledger_id, L.reason;
  end if;
  if L.reversed_at is not null then
    raise exception 'This intake was already reversed on %', L.reversed_at;
  end if;

  v := public._parent_inv_lock(L.product_id);
  if v.on_hand_grams < L.delta_grams then
    raise exception
      'Cannot reverse: only % g remain on hand but this intake added % g — the rest is already allocated.',
      v.on_hand_grams, L.delta_grams using errcode = 'check_violation';
  end if;

  v := public._parent_inv_write(
         L.product_id, -L.delta_grams, 0,
         'correction', 'intake_reversal', L.id, L.batch_no,
         'Reversal of intake ' || L.id::text);

  update public.parent_inventory_ledger
     set reversed_at = now(), reversed_by = auth.uid()
   where id = L.id;

  return jsonb_build_object(
    'reversed_ledger_id', L.id, 'product_id', L.product_id,
    'removed_grams', L.delta_grams, 'on_hand_grams', v.on_hand_grams);
end;
$$;

comment on function public.reverse_intake(uuid) is
  'Undo a bulk intake: debit its grams back out of the central pool. Blocked if that much is no longer on hand (already allocated). Operator-level (admin/operator/manager); audited.';

create or replace function public.reverse_allocation(p_allocation_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  A        public.allocations;
  ln       record;
  il       public.inventory_levels;
  v_block  text := '';
  v_parent public.parent_inventory;
  v_count  integer := 0;
begin
  if not public.is_operator() then
    raise exception 'Not authorized to reverse an allocation' using errcode = '42501';
  end if;

  select * into A from public.allocations where id = p_allocation_id for update;
  if A.id is null then
    raise exception 'Allocation % not found', p_allocation_id;
  end if;
  if A.reversed_at is not null then
    raise exception 'This allocation was already reversed on %', A.reversed_at;
  end if;

  -- Serialize against concurrent allocations/reversals on this central pool.
  v_parent := public._parent_inv_lock(A.product_id);

  -- Pass 1: verify EVERY child can return its units (all-or-nothing).
  for ln in
    select al.child_sku_id, al.units, cs.sku
      from public.allocation_lines al
      join public.child_skus cs on cs.id = al.child_sku_id
     where al.allocation_id = A.id
  loop
    il := public._inv_lock(ln.child_sku_id);
    if il.on_hand < ln.units or (il.on_hand - ln.units) < il.reserved then
      v_block := v_block || format(
        E'\n  - %s: %s allocated, but only %s free to reverse (%s on hand, %s reserved).',
        coalesce(ln.sku, '(no SKU)'), ln.units,
        greatest(il.on_hand - il.reserved, 0), il.on_hand, il.reserved);
    end if;
  end loop;

  if length(v_block) > 0 then
    raise exception 'Cannot reverse allocation - some units are already reserved or sold:%', v_block
      using errcode = 'check_violation';
  end if;

  -- Pass 2: remove each child's units (fires outbound-sync to push the lower available).
  for ln in
    select al.child_sku_id, al.units from public.allocation_lines al
     where al.allocation_id = A.id
  loop
    perform public._inv_write(
      ln.child_sku_id, -ln.units, 0, 0,
      'correction', 'allocation_reversal', A.id, 'Reversal of allocation ' || A.id::text);
    v_count := v_count + 1;
  end loop;

  -- Credit the central pool back and unwind the reporting allocated counter.
  v_parent := public._parent_inv_write(
                A.product_id, A.total_grams, -A.total_grams,
                'correction', 'allocation_reversal', A.id, null,
                'Reversal of allocation ' || A.id::text);

  update public.allocations
     set reversed_at = now(), reversed_by = auth.uid()
   where id = A.id;

  return jsonb_build_object(
    'reversed_allocation_id', A.id, 'product_id', A.product_id,
    'restored_grams', A.total_grams, 'children_reversed', v_count,
    'on_hand_grams', v_parent.on_hand_grams);
end;
$$;

comment on function public.reverse_allocation(uuid) is
  'Undo a whole allocation atomically: pull each child SKU''s units back and credit the CENTRAL pool. Blocked if any units are already reserved/sold. Re-syncs each store. Operator-level (admin/operator/manager); audited.';

-- ---- Reverse a recorded shake loss (current def from 0044) -------------------

create or replace function public.reverse_shake(p_ledger_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  L public.parent_inventory_ledger;
  v public.parent_inventory;
begin
  if not public.is_operator() then
    raise exception 'Not authorized to reverse shake' using errcode = '42501';
  end if;

  select * into L from public.parent_inventory_ledger where id = p_ledger_id for update;
  if L.id is null then
    raise exception 'Shake entry % not found', p_ledger_id;
  end if;
  if L.reason <> 'shake' then
    raise exception 'Ledger entry % is not a shake loss (it is %)', p_ledger_id, L.reason;
  end if;
  if L.reversed_at is not null then
    raise exception 'This shake was already reversed on %', L.reversed_at;
  end if;

  -- delta_grams is negative (a debit); credit the same magnitude back.
  v := public._parent_inv_write(
         L.product_id, -L.delta_grams, 0,
         'correction', 'shake_reversal', L.id, L.batch_no,
         'Reversal of shake ' || L.id::text);

  update public.parent_inventory_ledger
     set reversed_at = now(), reversed_by = auth.uid()
   where id = L.id;

  return jsonb_build_object(
    'reversed_ledger_id', L.id, 'product_id', L.product_id,
    'restored_grams', -L.delta_grams, 'on_hand_grams', v.on_hand_grams);
end;
$$;

comment on function public.reverse_shake(uuid) is
  'Undo a recorded shake loss: credit its grams back to the central pool and stamp the shake reversed. Operator-level (admin/operator/manager); audited.';

-- ---- Central packaging stock writers (current defs from 0048) ----------------

create or replace function public.receive_packaging(
  p_type uuid, p_qty integer, p_note text default null
) returns public.packaging_levels
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_operator() then
    raise exception 'receive_packaging: not authorized' using errcode = '42501';
  end if;
  if p_qty is null or p_qty <= 0 then
    raise exception 'receive_packaging: quantity must be positive (got %)', p_qty
      using errcode = 'check_violation';
  end if;
  perform public._pkg_lock(p_type);
  return public._pkg_write(p_type, p_qty, 'receipt', 'manual', null, p_note);
end;
$$;

create or replace function public.adjust_packaging(
  p_type uuid, p_delta integer, p_note text
) returns public.packaging_levels
language plpgsql security definer set search_path = '' as $$
declare v public.packaging_levels;
begin
  if not public.is_operator() then
    raise exception 'adjust_packaging: not authorized' using errcode = '42501';
  end if;
  if p_delta = 0 then
    raise exception 'adjust_packaging: delta must be non-zero';
  end if;
  if p_note is null or length(trim(p_note)) = 0 then
    raise exception 'adjust_packaging: a note is required';
  end if;
  v := public._pkg_lock(p_type);
  if v.on_hand + p_delta < 0 then
    raise exception 'Adjustment would make packaging on_hand negative: on_hand %, delta %',
      v.on_hand, p_delta using errcode = 'check_violation';
  end if;
  return public._pkg_write(p_type, p_delta, 'manual_adjustment', 'manual', null, p_note);
end;
$$;

create or replace function public.set_packaging_reorder_point(
  p_type uuid, p_point integer
) returns public.packaging_levels
language plpgsql security definer set search_path = '' as $$
declare v public.packaging_levels;
begin
  if not public.is_operator() then
    raise exception 'set_packaging_reorder_point: not authorized' using errcode = '42501';
  end if;
  if p_point is not null and p_point < 0 then
    raise exception 'set_packaging_reorder_point: reorder point cannot be negative';
  end if;
  perform public._pkg_lock(p_type);
  update public.packaging_levels
     set reorder_point = p_point, updated_at = now()
   where packaging_type_id = p_type
   returning * into v;
  return v;
end;
$$;

commit;
