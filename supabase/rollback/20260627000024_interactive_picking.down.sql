-- WMS — Migration 0024: DOWN
begin;

-- Restore pack_group to its 0012 shape (no picking gate).
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

  for r in
    select id from public.orders
     where group_id = p_group_id and status in ('created','picking')
  loop
    perform public.set_order_status(r.id, 'packed');
  end loop;

  return g;
end;
$$;

drop function if exists public.set_pick_qty(uuid, uuid, integer, boolean);
drop function if exists public.claim_pick(uuid, boolean);
drop function if exists public.pick_complete(uuid);
drop function if exists public.pick_required(uuid);

drop table if exists public.pick_claims;
drop table if exists public.pick_progress;

commit;
