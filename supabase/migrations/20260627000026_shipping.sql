-- ============================================================================
-- WMS — Migration 0026: shipping operations
--
-- The shipments/packages tables, their site-scoped RLS, and the
-- shipping_cost_report view already exist (migrations 0001, 0004, 0009). This
-- migration adds the guarded RPCs the packing screen's shipping panel needs,
-- mirroring the packing layer (record_packaging_usage / pack_group):
--
--   create_shipment      open a shipment on a group (status 'pending')
--   update_shipment      edit carrier / service / estimated+actual cost
--   set_shipment_status  pending -> shipped -> delivered, or -> cancelled
--   add_package          add a package (tracking / cost / weight) to a shipment
--   update_package       edit a package's tracking / cost / weight
--
-- DELIBERATELY operational only: shipping never touches the order lifecycle.
-- Fulfillment (inventory consume + pick-fee snapshot) stays a distinct, explicit
-- step via fulfill_order(). A group can be shipped before or after it is
-- fulfilled — the two are tracked independently.
--
-- These run as the caller (SECURITY INVOKER, like the packing RPCs), so the
-- existing shipments/packages RLS policies still gate every write. Deletes are
-- left to direct, admin-only table writes (matching packaging_usage).
-- ============================================================================

begin;

-- Open a shipment on a group. Refuses cancelled groups; everything else (open /
-- fulfilled) may still accrue shipments.
create or replace function public.create_shipment(
  p_group_id       uuid,
  p_carrier        text default null,
  p_service_level  text default null,
  p_estimated_cost numeric default null
) returns public.shipments
language plpgsql as $$
declare g public.fulfillment_groups; v public.shipments;
begin
  select * into g from public.fulfillment_groups where id = p_group_id for update;
  if not found then raise exception 'Group % not found', p_group_id; end if;
  if g.status = 'cancelled' then
    raise exception 'Group % is cancelled; cannot add a shipment', p_group_id;
  end if;
  if p_estimated_cost is not null and p_estimated_cost < 0 then
    raise exception 'estimated cost cannot be negative (got %)', p_estimated_cost;
  end if;

  insert into public.shipments (group_id, carrier, service_level, estimated_cost)
  values (p_group_id,
          nullif(btrim(p_carrier), ''),
          nullif(btrim(p_service_level), ''),
          p_estimated_cost)
  returning * into v;
  return v;
end;
$$;

comment on function public.create_shipment is
  'Open a pending shipment on a fulfillment group. Operational only — does not affect the order lifecycle.';

-- Edit a shipment's carrier / service / costs. Nulls clear the field. Bumps
-- updated_at so the report and UI reflect the change time.
create or replace function public.update_shipment(
  p_shipment_id    uuid,
  p_carrier        text default null,
  p_service_level  text default null,
  p_estimated_cost numeric default null,
  p_actual_cost    numeric default null
) returns public.shipments
language plpgsql as $$
declare v public.shipments;
begin
  if p_estimated_cost is not null and p_estimated_cost < 0 then
    raise exception 'estimated cost cannot be negative (got %)', p_estimated_cost;
  end if;
  if p_actual_cost is not null and p_actual_cost < 0 then
    raise exception 'actual cost cannot be negative (got %)', p_actual_cost;
  end if;

  update public.shipments
     set carrier        = nullif(btrim(p_carrier), ''),
         service_level  = nullif(btrim(p_service_level), ''),
         estimated_cost = p_estimated_cost,
         actual_cost    = p_actual_cost,
         updated_at     = now()
   where id = p_shipment_id
   returning * into v;
  if not found then raise exception 'Shipment % not found', p_shipment_id; end if;
  return v;
end;
$$;

comment on function public.update_shipment is
  'Edit a shipment''s carrier, service level, and estimated/actual cost.';

-- Move a shipment through its own status flow. Validates the transition; never
-- touches the order/fulfillment state. 'cancelled' is terminal here.
create or replace function public.set_shipment_status(
  p_shipment_id uuid, p_new_status text
) returns public.shipments
language plpgsql as $$
declare v public.shipments;
begin
  if p_new_status not in ('pending','shipped','delivered','cancelled') then
    raise exception 'invalid shipment status %', p_new_status;
  end if;
  select * into v from public.shipments where id = p_shipment_id for update;
  if not found then raise exception 'Shipment % not found', p_shipment_id; end if;
  if v.status = 'cancelled' then
    raise exception 'Shipment % is cancelled and cannot change status', p_shipment_id;
  end if;

  update public.shipments
     set status = p_new_status, updated_at = now()
   where id = p_shipment_id
   returning * into v;
  return v;
end;
$$;

comment on function public.set_shipment_status is
  'Advance a shipment''s status (pending/shipped/delivered/cancelled). Operational only — does not fulfill orders.';

-- Add a package to a shipment. Refuses cancelled shipments.
create or replace function public.add_package(
  p_shipment_id     uuid,
  p_tracking_number text default null,
  p_cost            numeric default null,
  p_weight_grams    integer default null
) returns public.packages
language plpgsql as $$
declare s public.shipments; v public.packages;
begin
  select * into s from public.shipments where id = p_shipment_id for update;
  if not found then raise exception 'Shipment % not found', p_shipment_id; end if;
  if s.status = 'cancelled' then
    raise exception 'Shipment % is cancelled; cannot add a package', p_shipment_id;
  end if;
  if p_cost is not null and p_cost < 0 then
    raise exception 'package cost cannot be negative (got %)', p_cost;
  end if;
  if p_weight_grams is not null and p_weight_grams < 0 then
    raise exception 'package weight cannot be negative (got %)', p_weight_grams;
  end if;

  insert into public.packages (shipment_id, tracking_number, cost, weight_grams)
  values (p_shipment_id, nullif(btrim(p_tracking_number), ''), p_cost, p_weight_grams)
  returning * into v;
  return v;
end;
$$;

comment on function public.add_package is
  'Add a package (tracking number, cost, weight) to a shipment.';

-- Edit a package's tracking / cost / weight. Nulls clear the field.
create or replace function public.update_package(
  p_package_id      uuid,
  p_tracking_number text default null,
  p_cost            numeric default null,
  p_weight_grams    integer default null
) returns public.packages
language plpgsql as $$
declare v public.packages;
begin
  if p_cost is not null and p_cost < 0 then
    raise exception 'package cost cannot be negative (got %)', p_cost;
  end if;
  if p_weight_grams is not null and p_weight_grams < 0 then
    raise exception 'package weight cannot be negative (got %)', p_weight_grams;
  end if;

  update public.packages
     set tracking_number = nullif(btrim(p_tracking_number), ''),
         cost            = p_cost,
         weight_grams    = p_weight_grams
   where id = p_package_id
   returning * into v;
  if not found then raise exception 'Package % not found', p_package_id; end if;
  return v;
end;
$$;

comment on function public.update_package is
  'Edit a package''s tracking number, cost, and weight.';

commit;
