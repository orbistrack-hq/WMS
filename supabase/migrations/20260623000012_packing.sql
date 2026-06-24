-- ============================================================================
-- WMS — Migration 0012: packing
--
-- Packaging consumption is already recorded against the fulfillment GROUP
-- (migration 0001), so a box/label is counted once for a combined-order group
-- and consumables (jars, bags, jar labels) sum across the group without double
-- counting. This migration adds the two missing pieces the packing screen needs:
--
--   * fulfillment_groups.packing_notes — a free-text note for the packed group.
--   * record_packaging_usage()         — insert a usage line, snapshotting the
--                                        packaging type's current unit cost so
--                                        later price changes don't rewrite history.
--   * pack_group()                     — save the note and advance every still-
--                                        open order in the group to 'packed'
--                                        (label-only move, no inventory effect).
-- ============================================================================

begin;

alter table public.fulfillment_groups
  add column if not exists packing_notes text;

-- Record one packaging line against a group, freezing the unit cost now.
create or replace function public.record_packaging_usage(
  p_group_id uuid, p_packaging_type_id uuid, p_quantity integer
) returns public.packaging_usage
language plpgsql as $$
declare v public.packaging_usage; v_cost numeric(12,2);
begin
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'packaging quantity must be positive (got %)', p_quantity;
  end if;
  select unit_cost into v_cost
    from public.packaging_types
   where id = p_packaging_type_id and is_active;
  if v_cost is null then
    raise exception 'packaging type % not found or inactive', p_packaging_type_id;
  end if;

  insert into public.packaging_usage
    (group_id, packaging_type_id, quantity, unit_cost_snapshot, recorded_by)
  values
    (p_group_id, p_packaging_type_id, p_quantity, v_cost, auth.uid())
  returning * into v;
  return v;
end;
$$;

comment on function public.record_packaging_usage is
  'Insert a packaging usage line for a fulfillment group, snapshotting the packaging type''s current unit cost.';

-- Confirm a group as packed: store the note and move its open orders to 'packed'.
create or replace function public.pack_group(
  p_group_id uuid, p_notes text default null
) returns public.fulfillment_groups
language plpgsql as $$
declare g public.fulfillment_groups; r record;
begin
  select * into g from public.fulfillment_groups where id = p_group_id for update;
  if not found then raise exception 'Group % not found', p_group_id; end if;
  if g.status <> 'open' then
    raise exception 'Group % is % and cannot be packed', p_group_id, g.status;
  end if;

  update public.fulfillment_groups
     set packing_notes = coalesce(p_notes, packing_notes)
   where id = p_group_id
   returning * into g;

  -- Advance orders that are still pre-pack. Already-packed orders are left as is;
  -- fulfilled/cancelled orders are never touched.
  for r in
    select id from public.orders
     where group_id = p_group_id and status in ('created','picking')
  loop
    perform public.set_order_status(r.id, 'packed');
  end loop;

  return g;
end;
$$;

comment on function public.pack_group is
  'Save a group''s packing note and advance its open orders (created/picking) to packed.';

commit;
