-- ============================================================================
-- WMS — Migration 0042: central parent inventory (FB-1)
--
-- The bulk parent pool stops being per-(product, site) and becomes CENTRAL:
-- one pool per parent SKU. Intake credits the central pool with no receiving
-- site; delegation (allocate_parent_stock) still hands grams to child SKUs at
-- any site(s), just drawn from the one central pool — so stock a store isn't
-- moving can be delegated elsewhere later instead of being pre-split at intake.
-- Delegation stays reversible (reverse_allocation credits the central pool back).
--
-- Transform-in-place (confirmed approach):
--   * parent_inventory              collapses to PK (product_id); existing
--                                   per-site balances are SUMMED into one row
--                                   per product. site_id column dropped.
--   * parent_inventory_ledger,      site_id made NULLABLE — historical rows keep
--     allocations                   their site; new central movements write NULL.
--   * primitives + RPCs             lose the p_site argument (signatures change,
--     (_parent_inv_lock/_write,     so the old ones are dropped and recreated).
--     intake_receive, allocate_,
--     reverse_intake/allocation)
--   * parent_inventory_report       becomes per-product (no site column).
--   * RLS reads open to any signed-in user (per deployment: one Supabase per
--     client, so internal team and client share the tenant). Writes stay sealed
--     behind the SECURITY DEFINER functions.
--
-- Reverse with rollback/20260707000042_central_parent_inventory.down.sql. The
-- down restores the per-site structure + the 0028/0029/0034 function bodies;
-- collapsing balances is one-way, so a real rollback starts pools at those sums.
-- ============================================================================

begin;

-- ---- 0. Drop dependents that key on the site dimension (recreated below) ----
drop view   if exists public.parent_inventory_report;
drop policy if exists parent_inventory_read        on public.parent_inventory;
drop policy if exists parent_inventory_ledger_read on public.parent_inventory_ledger;
drop policy if exists allocations_read             on public.allocations;
drop policy if exists allocation_lines_read        on public.allocation_lines;

drop function if exists public.intake_receive(uuid,uuid,numeric,text,text,text);
drop function if exists public.allocate_parent_stock(uuid,uuid,jsonb,text,text);
drop function if exists public.reverse_intake(uuid);
drop function if exists public.reverse_allocation(uuid);
drop function if exists public._parent_inv_write(uuid,uuid,numeric,numeric,text,text,uuid,text,text);
drop function if exists public._parent_inv_lock(uuid,uuid);

-- ---- 1. parent_inventory: collapse per-site rows into one central pool -------
alter table public.parent_inventory drop constraint parent_inventory_pkey;

create temporary table _pi_central on commit drop as
  select product_id,
         sum(on_hand_grams)   as on_hand_grams,
         sum(allocated_grams) as allocated_grams
    from public.parent_inventory
   group by product_id;

delete from public.parent_inventory;
-- Dropping the column also drops parent_inventory_site_idx and the sites FK.
alter table public.parent_inventory drop column site_id;
alter table public.parent_inventory add primary key (product_id);

insert into public.parent_inventory (product_id, on_hand_grams, allocated_grams)
  select product_id, on_hand_grams, allocated_grams from _pi_central;

-- ---- 2. Ledger + allocations: keep history, site becomes optional (NULL=central)
alter table public.parent_inventory_ledger alter column site_id drop not null;
alter table public.allocations             alter column site_id drop not null;

create index if not exists parent_inventory_ledger_product_idx
  on public.parent_inventory_ledger(product_id, created_at);
create index if not exists allocations_product_idx
  on public.allocations(product_id, created_at);

-- ---- 3. Central primitives (locked-row + ledger writer) ----------------------
create or replace function public._parent_inv_lock(p_product uuid)
returns public.parent_inventory language plpgsql as $$
declare v public.parent_inventory;
begin
  if p_product is null then raise exception '_parent_inv_lock: product is required'; end if;
  insert into public.parent_inventory(product_id) values (p_product)
    on conflict (product_id) do nothing;
  select * into v from public.parent_inventory where product_id = p_product for update;
  return v;
end;
$$;

create or replace function public._parent_inv_write(
  p_product uuid,
  p_delta_grams     numeric,
  p_delta_allocated numeric,
  p_reason text, p_ref_type text, p_ref_id uuid, p_batch_no text, p_note text
) returns public.parent_inventory language plpgsql as $$
declare v public.parent_inventory;
begin
  update public.parent_inventory
     set on_hand_grams   = on_hand_grams   + p_delta_grams,
         allocated_grams = allocated_grams + coalesce(p_delta_allocated, 0),
         updated_at      = now()
   where product_id = p_product
   returning * into v;

  insert into public.parent_inventory_ledger(
    product_id, site_id, delta_grams, reason,
    reference_type, reference_id, batch_no, note, actor)
  values (p_product, null, p_delta_grams, p_reason,
    p_ref_type, p_ref_id, p_batch_no, p_note, auth.uid());

  return v;
end;
$$;

-- ---- 4. Intake (central: no receiving site) ---------------------------------
create or replace function public.intake_receive(
  p_product_id uuid,
  p_qty        numeric,
  p_uom        text,
  p_batch_no   text default null,
  p_note       text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_grams numeric; v public.parent_inventory;
begin
  if p_product_id is null then
    raise exception 'intake_receive: product is required';
  end if;
  if not exists (select 1 from public.products where id = p_product_id) then
    raise exception 'intake_receive: product % not found', p_product_id;
  end if;

  v_grams := public.to_grams(p_qty, p_uom);
  if v_grams <= 0 then
    raise exception 'intake_receive: received quantity must be positive (got % %)', p_qty, p_uom
      using errcode = 'check_violation';
  end if;

  perform public._parent_inv_lock(p_product_id);
  v := public._parent_inv_write(
         p_product_id, v_grams, 0, 'intake', 'manual', null, p_batch_no, p_note);

  return jsonb_build_object(
    'product_id',     p_product_id,
    'received_grams', v_grams,
    'on_hand_grams',  v.on_hand_grams);
end;
$$;

comment on function public.intake_receive(uuid,numeric,text,text,text) is
  'Receive bulk into the CENTRAL parent pool (no site). Converts qty+uom to grams and credits parent_inventory. Returns the new on-hand grams.';

-- ---- 5. Allocation (central source → child SKUs at any site) -----------------
create or replace function public.allocate_parent_stock(
  p_product_id      uuid,
  p_lines           jsonb,              -- [{child_sku_id, units}]
  p_idempotency_key text default null,
  p_note            text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_parent      public.parent_inventory;
  v_line        jsonb;
  v_child_id    uuid;
  v_units       integer;
  v_gpu         numeric;
  v_child_prod  uuid;
  v_total       numeric := 0;
  v_alloc_id    uuid;
  v_child_count integer := 0;
begin
  if p_product_id is null then
    raise exception 'allocate_parent_stock: product is required';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array'
     or jsonb_array_length(p_lines) = 0 then
    raise exception 'allocate_parent_stock: at least one allocation line is required';
  end if;

  -- Idempotent replay: same key => return the prior result, no second debit.
  if p_idempotency_key is not null then
    select id into v_alloc_id from public.allocations
     where idempotency_key = p_idempotency_key;
    if found then
      return jsonb_build_object(
        'allocation_id',   v_alloc_id,
        'product_id',      p_product_id,
        'total_grams',     (select total_grams from public.allocations where id = v_alloc_id),
        'remaining_grams', (select on_hand_grams from public.parent_inventory
                              where product_id = p_product_id),
        'child_count',     (select count(*)::int from public.allocation_lines
                              where allocation_id = v_alloc_id),
        'replayed',        true);
    end if;
  end if;

  -- Lock the central pool so concurrent allocations serialize (no over-allocation).
  v_parent := public._parent_inv_lock(p_product_id);

  -- Pass 1: validate every line and sum the grams BEFORE any write.
  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_child_id := (v_line->>'child_sku_id')::uuid;
    v_units    := coalesce((v_line->>'units')::integer, 0);

    if v_child_id is null then
      raise exception 'allocate_parent_stock: line missing child_sku_id';
    end if;
    if v_units < 0 then
      raise exception 'allocate_parent_stock: units cannot be negative (child %)', v_child_id;
    end if;
    continue when v_units = 0;

    select product_id, grams_per_unit into v_child_prod, v_gpu
      from public.child_skus where id = v_child_id;
    if v_child_prod is null then
      raise exception 'allocate_parent_stock: child SKU % not found', v_child_id;
    end if;
    if v_child_prod <> p_product_id then
      raise exception 'allocate_parent_stock: child SKU % does not belong to parent %',
        v_child_id, p_product_id;
    end if;
    if v_gpu is null then
      raise exception 'allocate_parent_stock: child SKU % has no grams_per_unit; cannot allocate by grams',
        v_child_id;
    end if;

    v_total := v_total + (v_units * v_gpu);
  end loop;

  if v_total <= 0 then
    raise exception 'allocate_parent_stock: nothing to allocate (all lines zero)';
  end if;

  if v_total > v_parent.on_hand_grams then
    raise exception 'Total allocated inventory exceeds available Parent SKU inventory.'
      using errcode = 'check_violation';
  end if;

  begin
    insert into public.allocations (product_id, site_id, total_grams, note, idempotency_key, actor)
    values (p_product_id, null, v_total, p_note, p_idempotency_key, auth.uid())
    returning id into v_alloc_id;
  exception when unique_violation then
    select id into v_alloc_id from public.allocations where idempotency_key = p_idempotency_key;
    return jsonb_build_object(
      'allocation_id',   v_alloc_id,
      'product_id',      p_product_id,
      'total_grams',     (select total_grams from public.allocations where id = v_alloc_id),
      'remaining_grams', v_parent.on_hand_grams,
      'child_count',     (select count(*)::int from public.allocation_lines where allocation_id = v_alloc_id),
      'replayed',        true);
  end;

  -- Pass 2: record lines and credit each child's sellable on_hand. receive_stock
  -- writes a 'receipt' ledger row -> the outbound-sync trigger pushes the child's
  -- new available to its client store. Parent is never mapped.
  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_child_id := (v_line->>'child_sku_id')::uuid;
    v_units    := coalesce((v_line->>'units')::integer, 0);
    continue when v_units = 0;

    select grams_per_unit into v_gpu from public.child_skus where id = v_child_id;

    insert into public.allocation_lines (allocation_id, child_sku_id, units, grams_per_unit, grams)
    values (v_alloc_id, v_child_id, v_units, v_gpu, v_units * v_gpu);

    perform public.receive_stock(v_child_id, v_units, 'allocation', v_alloc_id, 'allocation');
    v_child_count := v_child_count + 1;
  end loop;

  v_parent := public._parent_inv_write(
                p_product_id, -v_total, v_total,
                'allocation', 'allocation', v_alloc_id, null, p_note);

  return jsonb_build_object(
    'allocation_id',   v_alloc_id,
    'product_id',      p_product_id,
    'total_grams',     v_total,
    'remaining_grams', v_parent.on_hand_grams,
    'child_count',     v_child_count,
    'replayed',        false);
end;
$$;

comment on function public.allocate_parent_stock(uuid,jsonb,text,text) is
  'Allocate CENTRAL parent grams to client child SKUs atomically. Validates total <= available, credits each child (which auto-syncs its store), debits the central pool, and records allocation history. Idempotent on p_idempotency_key.';

-- ---- 6. Reversals (central pool) --------------------------------------------
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
  'Undo a bulk intake: debit its grams back out of the central pool. Blocked if that much is no longer on hand (already allocated). Admin/operator only; audited.';

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
  'Undo a whole allocation atomically: pull each child SKU''s units back and credit the CENTRAL pool. Blocked if any units are already reserved/sold. Re-syncs each store. Admin/operator only; audited.';

-- ---- 7. Seal the primitives (SECURITY DEFINER, revoked from API roles) -------
alter function public._parent_inv_lock(uuid) security definer set search_path = '';
alter function public._parent_inv_write(uuid,numeric,numeric,text,text,uuid,text,text)
  security definer set search_path = '';

revoke execute on function public._parent_inv_lock(uuid) from public;
revoke execute on function public._parent_inv_write(uuid,numeric,numeric,text,text,uuid,text,text) from public;
do $$
declare r text;
begin
  foreach r in array array['authenticated','anon','app_user'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke execute on function public._parent_inv_lock(uuid) from %I', r);
      execute format('revoke execute on function public._parent_inv_write(uuid,numeric,numeric,text,text,uuid,text,text) from %I', r);
    end if;
  end loop;
end $$;

-- ---- 8. Grants for the RPCs -------------------------------------------------
revoke execute on function public.intake_receive(uuid,numeric,text,text,text) from public;
revoke execute on function public.allocate_parent_stock(uuid,jsonb,text,text) from public;
grant  execute on function public.intake_receive(uuid,numeric,text,text,text) to authenticated;
grant  execute on function public.allocate_parent_stock(uuid,jsonb,text,text) to authenticated;
revoke execute on function public.reverse_intake(uuid) from public;
revoke execute on function public.reverse_allocation(uuid) from public;
grant  execute on function public.reverse_intake(uuid) to authenticated;
grant  execute on function public.reverse_allocation(uuid) to authenticated;

-- ---- 9. RLS reads: open to any signed-in user (single-tenant per deployment) -
create policy parent_inventory_read on public.parent_inventory
  for select using (auth.uid() is not null);
create policy parent_inventory_ledger_read on public.parent_inventory_ledger
  for select using (auth.uid() is not null);
create policy allocations_read on public.allocations
  for select using (auth.uid() is not null);
create policy allocation_lines_read on public.allocation_lines
  for select using (auth.uid() is not null);

-- ---- 10. Central report view ------------------------------------------------
create view public.parent_inventory_report with (security_invoker = true) as
select pi.product_id,
       p.name           as product_name,
       pi.on_hand_grams as available_grams,
       pi.allocated_grams,
       pi.updated_at
from public.parent_inventory pi
join public.products p on p.id = pi.product_id;

comment on view public.parent_inventory_report is
  'Central parent bulk inventory per product: available (unallocated) grams and cumulative allocated grams. Readable by any signed-in user.';

grant select on public.parent_inventory_report to authenticated;

commit;
