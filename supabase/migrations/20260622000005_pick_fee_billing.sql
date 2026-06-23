-- ============================================================================
-- WMS — Migration 0005: pick-fee billing
--
-- Pick fees are CLIENT charges (the billable ledger), kept separate from the
-- operation's internal packaging/shipping costs. Tiered per unit: first unit at
-- the schedule's first rate, each additional unit at the additional rate. The
-- first-unit premium applies once PER ORDER, never once per combined group.
--
-- Effective-dated: the rate in effect on the order's fulfillment date is
-- resolved and SNAPSHOTTED onto the charge (amount + fee_schedule_id), so a
-- later rate change never rewrites an already-billed order.
--
-- Functions:
--   pick_fee_amount(units, first, addl)      pure tiered math
--   resolve_fee_schedule(as_of, client)      latest schedule effective <= date
--   calc_order_pick_fee(order, as_of?)       preview, NO write (packing screen)
--   charge_order_pick_fee(order, recompute?) commit one snapshot per order
--   charge_group_pick_fees(group, recompute?) charge each order in a group
-- ============================================================================

begin;

-- At most one pick-fee charge per order — the idempotency backstop.
create unique index billing_charges_one_pick_fee
  on public.billing_charges(order_id) where fee_type = 'pick_fee';

-- Pure tiered amount.
create or replace function public.pick_fee_amount(p_units integer, p_first numeric, p_additional numeric)
returns numeric language sql immutable as $$
  select case when p_units <= 0 then 0::numeric
              else p_first + (p_units - 1) * p_additional end;
$$;

-- Resolve the schedule in effect as of a date. client_id is null in Phase A
-- (single implicit client); the match keeps the column for future per-client rates.
create or replace function public.resolve_fee_schedule(p_as_of date, p_client_id uuid default null)
returns public.fee_schedules language sql stable as $$
  select * from public.fee_schedules
   where effective_from <= p_as_of
     and (client_id is not distinct from p_client_id)
   order by effective_from desc
   limit 1;
$$;

-- Preview only (no write) — drives the packing screen's live fee display.
create or replace function public.calc_order_pick_fee(p_order_id uuid, p_as_of date default null)
returns numeric language plpgsql stable as $$
declare
  v_units integer;
  v_date  date;
  v_sched public.fee_schedules;
begin
  select coalesce(p_as_of, fulfilled_at::date, current_date) into v_date
    from public.orders where id = p_order_id;
  if v_date is null then raise exception 'Order % not found', p_order_id; end if;
  select coalesce(sum(quantity),0) into v_units
    from public.order_line_items where order_id = p_order_id;
  v_sched := public.resolve_fee_schedule(v_date);
  if v_sched.id is null then raise exception 'No fee schedule effective as of %', v_date; end if;
  return public.pick_fee_amount(v_units, v_sched.first_unit_rate, v_sched.additional_unit_rate);
end;
$$;

-- Commit the snapshot. Idempotent: one pick_fee charge per order; pass
-- p_recompute => true to refresh it. SECURITY DEFINER so the system writes the
-- authoritative charge regardless of who triggers fulfillment.
create or replace function public.charge_order_pick_fee(p_order_id uuid, p_recompute boolean default false)
returns public.billing_charges
language plpgsql security definer set search_path = '' as $$
declare
  v_existing public.billing_charges;
  v_has_existing boolean;
  v_units integer;
  v_date  date;
  v_sched public.fee_schedules;
  v_amount numeric;
  v_row public.billing_charges;
begin
  select * into v_existing from public.billing_charges
   where order_id = p_order_id and fee_type = 'pick_fee';
  v_has_existing := found;
  if v_has_existing and not p_recompute then
    return v_existing;                                  -- already billed; never alter
  end if;

  select coalesce(fulfilled_at::date, current_date) into v_date
    from public.orders where id = p_order_id;
  if v_date is null then raise exception 'Order % not found', p_order_id; end if;
  select coalesce(sum(quantity),0) into v_units
    from public.order_line_items where order_id = p_order_id;
  if v_units = 0 then raise exception 'Order % has no units to bill', p_order_id; end if;

  v_sched := public.resolve_fee_schedule(v_date);
  if v_sched.id is null then raise exception 'No fee schedule effective as of %', v_date; end if;
  v_amount := public.pick_fee_amount(v_units, v_sched.first_unit_rate, v_sched.additional_unit_rate);

  if v_has_existing then
    delete from public.billing_charges where order_id = p_order_id and fee_type = 'pick_fee';
  end if;

  insert into public.billing_charges(
    order_id, fee_type, quantity, unit_amount, amount, fee_schedule_id, description)
  values (p_order_id, 'pick_fee', v_units, v_sched.additional_unit_rate, v_amount, v_sched.id,
          format('Pick fee: %s unit(s); first %s, additional %s',
                 v_units, v_sched.first_unit_rate, v_sched.additional_unit_rate))
  returning * into v_row;
  return v_row;
end;
$$;

-- Charge every order in a fulfillment group (first-unit premium once per ORDER).
create or replace function public.charge_group_pick_fees(p_group_id uuid, p_recompute boolean default false)
returns void language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  for r in select id from public.orders where group_id = p_group_id loop
    perform public.charge_order_pick_fee(r.id, p_recompute);
  end loop;
end;
$$;

commit;