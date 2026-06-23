-- ============================================================================
-- WMS — Migration 0008: operational helpers
--
-- group_packaging_cost(group)  internal packaging cost for a fulfillment group
--                              (box/label counted once; recorded at group level
--                              already, so combined orders never double-count).
--                              This is operator COST, separate from the client
--                              pick-fee CHARGE in billing_charges.
-- combinable_orders(order)     other active orders that may merge with this one:
--                              same customer + same ship-to within 24h.
-- combine_orders(order_ids[])  perform the merge: repoint all into one group,
--                              cancel the emptied groups. Each order keeps its
--                              number/status; box/label/shipping then attach to
--                              the single surviving group.
-- ============================================================================

begin;

-- Live packaging cost for the packing screen.
create or replace function public.group_packaging_cost(p_group_id uuid)
returns numeric language sql stable as $$
  select coalesce(sum(quantity * unit_cost_snapshot), 0)
    from public.packaging_usage where group_id = p_group_id;
$$;

-- Candidates to combine with the given order: same customer + ship-to, within
-- 24h, both still active. The 24h window is the auto-flag rule.
create or replace function public.combinable_orders(p_order_id uuid)
returns setof public.orders language sql stable as $$
  select o2.*
  from public.orders o1
  join public.orders o2
    on o2.id <> o1.id
   and o2.site_id = o1.site_id
   and o2.customer_id = o1.customer_id
   and o2.ship_to_key = o1.ship_to_key
   and o2.status not in ('fulfilled','cancelled')
   and abs(extract(epoch from (o2.entered_at - o1.entered_at))) <= 86400
  where o1.id = p_order_id
    and o1.customer_id is not null
    and o1.status not in ('fulfilled','cancelled');
$$;

-- Perform the merge. Validates the orders share site + customer + ship-to and
-- are active (the 24h window is left to the caller, who may combine manually).
-- Returns the surviving group id.
create or replace function public.combine_orders(p_order_ids uuid[])
returns uuid language plpgsql as $$
declare
  v_n      integer := array_length(p_order_ids, 1);
  v_active integer;
  v_sites  integer;
  v_custs  integer;
  v_ships  integer;
  v_target uuid;
begin
  if v_n is null or v_n < 2 then
    raise exception 'combine_orders needs at least two orders';
  end if;

  select count(*) filter (where status not in ('fulfilled','cancelled') and customer_id is not null),
         count(distinct site_id), count(distinct customer_id), count(distinct ship_to_key)
    into v_active, v_sites, v_custs, v_ships
    from public.orders where id = any(p_order_ids);

  if v_active <> v_n then
    raise exception 'all orders must exist, be active, and have a customer';
  end if;
  if v_sites <> 1 or v_custs <> 1 or v_ships <> 1 then
    raise exception 'orders must share the same site, customer, and ship-to address';
  end if;

  -- keep the earliest-entered order's group as the survivor
  select group_id into v_target
    from public.orders where id = any(p_order_ids) order by entered_at asc limit 1;
  update public.orders set group_id = v_target where id = any(p_order_ids);

  -- cancel any group left empty by the move
  update public.fulfillment_groups g set status = 'cancelled'
   where g.status = 'open'
     and not exists (select 1 from public.orders o where o.group_id = g.id);

  return v_target;
end;
$$;

commit;