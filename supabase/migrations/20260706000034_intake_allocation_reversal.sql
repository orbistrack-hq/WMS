-- ============================================================================
-- WMS — Migration 0034: reverse intake + allocation (undo, OrbisTrack)
--
-- Adds two guarded, auditable "undo" operations for the intake/allocation flow:
--
--   reverse_intake(ledger_id)     — undo a bulk intake: debit the grams back out
--     of the parent pool. Blocked (clear message) if that much is no longer on
--     hand because it was already allocated.
--
--   reverse_allocation(alloc_id)  — undo a whole allocation, all-or-nothing:
--     pull each child SKU's units back and credit the pool. Blocked (clear
--     message, naming the SKUs) if ANY of those units are already reserved or
--     sold. Removing the child units fires the same outbound-sync trigger, so
--     each client store is pushed its corrected (lower) available.
--
-- Both are safe by construction: the existing non-negative / on_hand>=reserved
-- guards mean a reversal either fully succeeds (stock untouched) or fails with a
-- friendly message — it can never drive inventory negative or strand committed
-- stock. Reversal movements are logged with reason 'correction' and a
-- reference_type of 'intake_reversal' / 'allocation_reversal' for reporting, and
-- the original row is stamped reversed_at/by so it can't be undone twice.
--
-- Authorization: admin OR operator (internal team). SECURITY DEFINER so they can
-- drive the sealed inventory primitives; execution granted to 'authenticated'
-- with the role check enforced inside.
-- ============================================================================

begin;

-- 1. Track that an intake row / allocation has been reversed (block double-undo).
alter table public.allocations
  add column if not exists reversed_at timestamptz,
  add column if not exists reversed_by uuid references public.profiles(id);

alter table public.parent_inventory_ledger
  add column if not exists reversed_at timestamptz,
  add column if not exists reversed_by uuid references public.profiles(id);

-- 2. reverse_intake -----------------------------------------------------------
create or replace function public.reverse_intake(p_ledger_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  L public.parent_inventory_ledger;
  v public.parent_inventory;
begin
  if public.app_role() not in ('admin','operator') then
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

  v := public._parent_inv_lock(L.product_id, L.site_id);
  if v.on_hand_grams < L.delta_grams then
    raise exception
      'Cannot reverse: only % g remain on hand but this intake added % g — the rest is already allocated.',
      v.on_hand_grams, L.delta_grams using errcode = 'check_violation';
  end if;

  v := public._parent_inv_write(
         L.product_id, L.site_id, -L.delta_grams, 0,
         'correction', 'intake_reversal', L.id, L.batch_no,
         'Reversal of intake ' || L.id::text);

  update public.parent_inventory_ledger
     set reversed_at = now(), reversed_by = auth.uid()
   where id = L.id;

  return jsonb_build_object(
    'reversed_ledger_id', L.id, 'product_id', L.product_id, 'site_id', L.site_id,
    'removed_grams', L.delta_grams, 'on_hand_grams', v.on_hand_grams);
end;
$$;

comment on function public.reverse_intake(uuid) is
  'Undo a bulk intake: debit its grams back out of the parent pool. Blocked if that much is no longer on hand (already allocated). Admin/operator only; audited.';

-- 3. reverse_allocation -------------------------------------------------------
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
  if public.app_role() not in ('admin','operator') then
    raise exception 'Not authorized to reverse an allocation' using errcode = '42501';
  end if;

  select * into A from public.allocations where id = p_allocation_id for update;
  if A.id is null then
    raise exception 'Allocation % not found', p_allocation_id;
  end if;
  if A.reversed_at is not null then
    raise exception 'This allocation was already reversed on %', A.reversed_at;
  end if;

  -- Serialize against concurrent allocations/reversals on this pool.
  v_parent := public._parent_inv_lock(A.product_id, A.site_id);

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

  -- Pass 2: remove each child's units. This writes a 'correction' ledger row,
  -- which fires the outbound-sync trigger to push the lower available downstream.
  for ln in
    select al.child_sku_id, al.units from public.allocation_lines al
     where al.allocation_id = A.id
  loop
    perform public._inv_write(
      ln.child_sku_id, -ln.units, 0, 0,
      'correction', 'allocation_reversal', A.id, 'Reversal of allocation ' || A.id::text);
    v_count := v_count + 1;
  end loop;

  -- Credit the parent pool back and unwind the reporting allocated counter.
  v_parent := public._parent_inv_write(
                A.product_id, A.site_id, A.total_grams, -A.total_grams,
                'correction', 'allocation_reversal', A.id, null,
                'Reversal of allocation ' || A.id::text);

  update public.allocations
     set reversed_at = now(), reversed_by = auth.uid()
   where id = A.id;

  return jsonb_build_object(
    'reversed_allocation_id', A.id, 'product_id', A.product_id, 'site_id', A.site_id,
    'restored_grams', A.total_grams, 'children_reversed', v_count,
    'on_hand_grams', v_parent.on_hand_grams);
end;
$$;

comment on function public.reverse_allocation(uuid) is
  'Undo a whole allocation atomically: pull each child SKU''s units back and credit the pool. Blocked if any units are already reserved/sold. Re-syncs each store. Admin/operator only; audited.';

-- 4. Grants: callable by the app; sealed from anon.
revoke execute on function public.reverse_intake(uuid) from public;
revoke execute on function public.reverse_allocation(uuid) from public;
grant  execute on function public.reverse_intake(uuid) to authenticated;
grant  execute on function public.reverse_allocation(uuid) to authenticated;

commit;
