-- ============================================================================
-- WMS — Migration 0041: order returns (bounced orders) — FB-2
--
-- A fulfilled order that bounces back to us gets a new terminal status,
-- 'returned', reachable ONLY through return_order() so the inventory side effect
-- can never be skipped by a bare status update. Returning:
--   * puts each line's units back to sellable on_hand (reason 'order_return',
--     distinct from a fresh receipt so the returns report can count bounces);
--   * leaves the pick fee / postage charged (they stand) and does NOT restock
--     consumables (jars/bags/box/label are written off) — per ops decisions;
--   * bounces ONLY that order, never the rest of its combined group.
-- A returned order can be re-opened (returned -> created) via reopen_order(),
-- which re-reserves stock through the existing apply_order_creation path.
--
-- 'returned' is otherwise terminal: set_order_status / fulfill_order /
-- cancel_order all refuse to act on it (use reopen_order first). Those three are
-- redefined here from their latest bodies (fulfill from 0028; set_status/cancel
-- from 0007) with the extra guard — the down file restores them verbatim.
--
-- returns_report exposes one row per returned order (site/customer/channel/
-- dates/units/value) for the client-facing bounce report, RLS-scoped.
--
-- Reverse with rollback/20260707000041_order_returns.down.sql.
-- ============================================================================

begin;

-- ---- 1. Schema: status value, returned_at, ledger reason -------------------
alter table public.orders drop constraint orders_status_check;
alter table public.orders add constraint orders_status_check
  check (status in ('created','picking','packed','fulfilled','cancelled','returned'));
alter table public.orders add column if not exists returned_at timestamptz;

alter table public.inventory_ledger drop constraint inventory_ledger_reason_check;
alter table public.inventory_ledger add constraint inventory_ledger_reason_check
  check (reason in (
    'order_reserve','order_release','order_consume',
    'layaway_remove','layaway_cancel','layaway_consume',
    'manual_adjustment','receipt','correction',
    'shopify_sync',   -- added in 0017; MUST be preserved (store-sync writes it
                      -- and the 0026 loop-suppression trigger keys off it)
    'order_return'));

-- ---- 2. Inventory primitive: restock returned units ------------------------
-- Mirrors receive_stock (SECURITY DEFINER, locked) but tags the movement
-- 'order_return' so bounced goods are distinguishable from new receipts.
create or replace function public.return_stock(
  p_child_sku_id uuid, p_qty integer,
  p_ref_type text default 'order_line_item', p_ref_id uuid default null,
  p_note text default null
) returns public.inventory_levels
language plpgsql security definer set search_path = '' as $$
begin
  if p_qty <= 0 then
    raise exception 'return qty must be positive (got %)', p_qty
      using errcode = 'check_violation';
  end if;
  perform public._inv_lock(p_child_sku_id);
  return public._inv_write(
    p_child_sku_id, p_qty, 0, 0, 'order_return', p_ref_type, p_ref_id, p_note);
end;
$$;

-- Restock every line of an order to sellable on_hand. Standard and layaway
-- alike: at fulfillment both leave on_hand reduced, so a return adds it back.
create or replace function public.apply_order_return(p_order_id uuid)
returns void language plpgsql as $$
declare r record;
begin
  if not exists (select 1 from public.orders where id = p_order_id) then
    raise exception 'Order % not found', p_order_id;
  end if;
  for r in
    select id, child_sku_id, quantity
      from public.order_line_items where order_id = p_order_id
  loop
    perform public.return_stock(r.child_sku_id, r.quantity, 'order_line_item', r.id);
  end loop;
end;
$$;

-- ---- 3. Lifecycle: return_order + reopen_order -----------------------------
create or replace function public.return_order(p_order_id uuid)
returns public.orders language plpgsql as $$
declare v public.orders;
begin
  select * into v from public.orders where id = p_order_id for update;
  if not found then raise exception 'Order % not found', p_order_id; end if;
  if v.status <> 'fulfilled' then
    raise exception 'Only a fulfilled order can be returned (order % is %)',
      p_order_id, v.status;
  end if;

  update public.orders set status = 'returned', returned_at = now()
   where id = p_order_id returning * into v;
  perform public.apply_order_return(p_order_id);  -- restock to on_hand
  -- Pick fee / postage stand (no reversal); consumables written off (no restock).
  return v;
end;
$$;

create or replace function public.reopen_order(p_order_id uuid)
returns public.orders language plpgsql as $$
declare v public.orders;
begin
  select * into v from public.orders where id = p_order_id for update;
  if not found then raise exception 'Order % not found', p_order_id; end if;
  if v.status <> 'returned' then
    raise exception 'Only a returned order can be re-opened (order % is %)',
      p_order_id, v.status;
  end if;

  update public.orders set status = 'created', returned_at = null
   where id = p_order_id returning * into v;
  -- Re-reserve (standard) / re-book (layaway) through the same path a fresh
  -- order uses. Strict reserve: if the returned stock has since sold, this
  -- fails cleanly rather than overselling.
  perform public.apply_order_creation(p_order_id);
  return v;
end;
$$;

-- ---- 4. Guard 'returned' out of the other transitions ----------------------
-- set_order_status: also refuse a returned order (was fulfilled/cancelled only).
create or replace function public.set_order_status(p_order_id uuid, p_new_status text)
returns public.orders language plpgsql as $$
declare v public.orders;
begin
  if p_new_status not in ('created','picking','packed') then
    raise exception 'set_order_status handles created/picking/packed only; use fulfill_order() or cancel_order() for %', p_new_status;
  end if;
  select * into v from public.orders where id = p_order_id for update;
  if not found then raise exception 'Order % not found', p_order_id; end if;
  if v.status in ('fulfilled','cancelled','returned') then
    raise exception 'Order % is % and cannot change status', p_order_id, v.status;
  end if;
  update public.orders set status = p_new_status where id = p_order_id returning * into v;
  return v;
end;
$$;

-- fulfill_order (0028 body) + refuse a returned order.
create or replace function public.fulfill_order(
  p_order_id     uuid,
  p_fulfilled_at timestamptz default null
)
returns public.orders language plpgsql as $$
declare
  v    public.orders;
  v_at timestamptz := coalesce(p_fulfilled_at, now());
begin
  select * into v from public.orders where id = p_order_id for update;
  if not found then raise exception 'Order % not found', p_order_id; end if;
  if v.status = 'fulfilled' then raise exception 'Order % already fulfilled', p_order_id; end if;
  if v.status = 'cancelled' then raise exception 'Order % is cancelled and cannot be fulfilled', p_order_id; end if;
  if v.status = 'returned' then raise exception 'Order % is returned; re-open it before fulfilling', p_order_id; end if;

  update public.orders set status = 'fulfilled', fulfilled_at = v_at
   where id = p_order_id returning * into v;
  perform public.apply_order_fulfillment(p_order_id);
  perform public.charge_order_pick_fee(p_order_id);

  update public.fulfillment_groups g set status = 'fulfilled', fulfilled_at = v_at
   where g.id = v.group_id
     and not exists (select 1 from public.orders o where o.group_id = g.id and o.status <> 'fulfilled');
  return v;
end;
$$;

-- cancel_order (0007 body) + refuse a returned order.
create or replace function public.cancel_order(p_order_id uuid)
returns public.orders language plpgsql as $$
declare v public.orders;
begin
  select * into v from public.orders where id = p_order_id for update;
  if not found then raise exception 'Order % not found', p_order_id; end if;
  if v.status = 'fulfilled' then raise exception 'Order % is fulfilled and cannot be cancelled', p_order_id; end if;
  if v.status = 'cancelled' then raise exception 'Order % already cancelled', p_order_id; end if;
  if v.status = 'returned' then raise exception 'Order % is returned; re-open it before cancelling', p_order_id; end if;

  perform public.apply_order_cancellation(p_order_id);
  update public.orders set status = 'cancelled', cancelled_at = now() where id = p_order_id returning * into v;
  return v;
end;
$$;

-- ---- 5. Grants -------------------------------------------------------------
revoke execute on function public.return_stock(uuid,integer,text,uuid,text) from public;
grant  execute on function public.return_stock(uuid,integer,text,uuid,text) to authenticated;
grant  execute on function public.apply_order_return(uuid) to authenticated;
grant  execute on function public.return_order(uuid) to authenticated;
grant  execute on function public.reopen_order(uuid) to authenticated;

-- ---- 6. Returns report -----------------------------------------------------
create view public.returns_report with (security_invoker = true) as
select
  o.id            as order_id,
  o.order_number,
  o.site_id,
  s.name          as site_name,
  o.customer_id,
  c.name          as customer_name,
  o.channel,
  o.order_type,
  o.entered_at,
  o.sale_date,
  o.returned_at,
  coalesce(li.line_count, 0)  as line_count,
  coalesce(li.unit_count, 0)  as unit_count,
  coalesce(li.order_value, 0) as order_value
from public.orders o
join public.sites s on s.id = o.site_id
left join public.customers c on c.id = o.customer_id
left join lateral (
  select count(*)        as line_count,
         sum(quantity)   as unit_count,
         sum(quantity * unit_price - coalesce(discount,0) + coalesce(tax,0)) as order_value
    from public.order_line_items
   where order_id = o.id
) li on true
where o.status = 'returned';

grant select on public.returns_report to authenticated;

comment on view public.returns_report is
  'One row per returned (bounced) order — site, customer, channel, entered/sale/returned dates, line + unit counts and order value. RLS-scoped; drives the client-facing returns report.';

commit;
