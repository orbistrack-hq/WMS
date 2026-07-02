-- ============================================================================
-- WMS — Migration 0029: intake + allocation RPCs (OrbisTrack, A2)
--
-- The two orchestrating transactions on top of the 0028 schema:
--
--   intake_receive(product, site, qty, uom, ...)  — convert to grams and credit
--     the parent bulk pool. One ledger row (reason 'intake').
--
--   allocate_parent_stock(product, site, lines[], key, note) — the core, all-or-
--     nothing allocation. Validates Σ(units × grams_per_unit) <= parent available
--     BEFORE any write, credits each child SKU's sellable on_hand (via the guarded
--     receive_stock, so the existing outbound-sync trigger fires and pushes the
--     new available to that client's store), debits the parent pool, and records
--     allocations + allocation_lines with the acting employee and a timestamp.
--
-- Cross-site by design: the parent pool lives at the intake site; each child may
-- live at a different client site (Client = Site). Lines are validated to belong
-- to the parent product; child.site is NOT forced to equal the pool site.
--
-- Idempotent: an idempotency_key replays to the same result without a second
-- debit, so a double-click / retried request never double-allocates.
--
-- Both are SECURITY DEFINER so they can drive the sealed 0028 primitives; only
-- 'authenticated' may execute them. Reverse with the matching down migration.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. intake_receive — bulk stock arrives at a site's parent pool.
-- ----------------------------------------------------------------------------
create or replace function public.intake_receive(
  p_product_id uuid,
  p_site_id    uuid,
  p_qty        numeric,
  p_uom        text,
  p_batch_no   text default null,
  p_note       text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_grams numeric;
  v       public.parent_inventory;
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
         p_product_id, p_site_id, v_grams, 0,
         'intake', 'manual', null, p_batch_no, p_note);

  return jsonb_build_object(
    'product_id',    p_product_id,
    'site_id',       p_site_id,
    'received_grams', v_grams,
    'on_hand_grams',  v.on_hand_grams);
end;
$$;

comment on function public.intake_receive(uuid,uuid,numeric,text,text,text) is
  'Receive bulk into the parent pool at a site. Converts qty+uom to grams and credits parent_inventory. Returns the new on-hand grams.';

-- ----------------------------------------------------------------------------
-- 2. allocate_parent_stock — distribute parent grams to client child SKUs.
-- ----------------------------------------------------------------------------
create or replace function public.allocate_parent_stock(
  p_product_id      uuid,
  p_site_id         uuid,               -- the parent pool's (intake) site
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
  if p_product_id is null or p_site_id is null then
    raise exception 'allocate_parent_stock: product and site are required';
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
        'allocation_id',  v_alloc_id,
        'product_id',     p_product_id,
        'site_id',        p_site_id,
        'total_grams',    (select total_grams from public.allocations where id = v_alloc_id),
        'remaining_grams',(select on_hand_grams from public.parent_inventory
                             where product_id = p_product_id and site_id = p_site_id),
        'child_count',    (select count(*)::int from public.allocation_lines
                             where allocation_id = v_alloc_id),
        'replayed',       true);
    end if;
  end if;

  -- Lock the parent pool so concurrent allocations serialize (no over-allocation).
  v_parent := public._parent_inv_lock(p_product_id, p_site_id);

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
    continue when v_units = 0;   -- blank input is fine, just skip it

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

  -- The one guard the whole feature exists to enforce.
  if v_total > v_parent.on_hand_grams then
    raise exception 'Total allocated inventory exceeds available Parent SKU inventory.'
      using errcode = 'check_violation';
  end if;

  -- Header. The unique idempotency_key is the backstop against a concurrent
  -- duplicate slipping past the pre-check above.
  begin
    insert into public.allocations (product_id, site_id, total_grams, note, idempotency_key, actor)
    values (p_product_id, p_site_id, v_total, p_note, p_idempotency_key, auth.uid())
    returning id into v_alloc_id;
  exception when unique_violation then
    select id into v_alloc_id from public.allocations where idempotency_key = p_idempotency_key;
    return jsonb_build_object(
      'allocation_id',   v_alloc_id,
      'product_id',      p_product_id,
      'site_id',         p_site_id,
      'total_grams',     (select total_grams from public.allocations where id = v_alloc_id),
      'remaining_grams', v_parent.on_hand_grams,
      'child_count',     (select count(*)::int from public.allocation_lines where allocation_id = v_alloc_id),
      'replayed',        true);
  end;

  -- Pass 2: record lines and credit each child's sellable on_hand. receive_stock
  -- writes a 'receipt' ledger row -> the outbound-sync trigger enqueues the push
  -- of the child's new available to its client store. Parent is never mapped.
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

  -- Debit the parent pool (and bump the reporting allocated counter).
  v_parent := public._parent_inv_write(
                p_product_id, p_site_id, -v_total, v_total,
                'allocation', 'allocation', v_alloc_id, null, p_note);

  return jsonb_build_object(
    'allocation_id',   v_alloc_id,
    'product_id',      p_product_id,
    'site_id',         p_site_id,
    'total_grams',     v_total,
    'remaining_grams', v_parent.on_hand_grams,
    'child_count',     v_child_count,
    'replayed',        false);
end;
$$;

comment on function public.allocate_parent_stock(uuid,uuid,jsonb,text,text) is
  'Allocate parent grams to client child SKUs atomically. Validates total <= available, credits each child (which auto-syncs its store), debits the pool, and records allocation history. Idempotent on p_idempotency_key.';

-- ----------------------------------------------------------------------------
-- 3. Grants: callable by the app; sealed from anon.
-- ----------------------------------------------------------------------------
revoke execute on function public.intake_receive(uuid,uuid,numeric,text,text,text) from public;
revoke execute on function public.allocate_parent_stock(uuid,uuid,jsonb,text,text) from public;
grant  execute on function public.intake_receive(uuid,uuid,numeric,text,text,text) to authenticated;
grant  execute on function public.allocate_parent_stock(uuid,uuid,jsonb,text,text) to authenticated;

commit;
