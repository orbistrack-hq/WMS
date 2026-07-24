-- ============================================================================
-- WMS — Migration 0081: flipping a SKU to non-inventory cleans up after itself
--
-- Migration 0069 gave admins/managers a manual toggle for
-- child_skus.track_inventory, but it only flipped the flag. Turning tracking OFF
-- does not touch the fictional stock the SKU already accumulated, nor the
-- backordered_qty already written onto open order lines when it was still
-- tracked — so an order that carried the SKU stayed blocked by
-- apply_order_fulfillment ("N unit(s) still backordered awaiting stock") even
-- after the operator flagged it non-inventory. promote_backorders can't help: a
-- non-inventory SKU has no on_hand to promote against.
--
-- Migration 0068 already does exactly the right cleanup — but only once, at
-- migration time, and only for the name pattern 'shipping protection%'. A
-- hand-made fee product (e.g. "Rush Shipping Upgrade") matches nothing and is
-- left stuck.
--
-- FIX. When set_child_track_inventory flips a SKU to false, run the same 0068
-- cleanup scoped to that single child: zero its fictional stock/reservations,
-- clear the backorder shortfall it created on open lines, and recompute the
-- order-level flag for the orders it touched. Turning tracking back ON does NO
-- cleanup — any real stock stands.
--
-- CREATE OR REPLACE resets unspecified attributes, so SECURITY DEFINER and the
-- pinned empty search_path (0069) are re-declared; the role gate reads the JWT
-- (app_role()), not the SQL role, so DEFINER doesn't weaken it. All object refs
-- are schema-qualified because search_path is empty. The direct inventory_levels
-- reset is deliberate (not a ledger write): the stock never physically existed,
-- so there is nothing real to audit — matching 0068. The child_skus flag flip is
-- still captured by the generic audit trigger.
--
-- Reverse with the matching rollback/…0081….down.sql (restores the 0069 body).
-- ============================================================================

begin;

create or replace function public.set_child_track_inventory(
  p_child_sku_id uuid,
  p_track        boolean
) returns public.child_skus
language plpgsql security definer set search_path = '' as $$
declare
  v       public.child_skus;
  v_track boolean := coalesce(p_track, true);
begin
  if public.app_role() not in ('admin', 'manager') then
    raise exception 'set_child_track_inventory requires the admin or manager role'
      using errcode = 'insufficient_privilege';
  end if;

  update public.child_skus
     set track_inventory = v_track,
         updated_at = now()
   where id = p_child_sku_id
   returning * into v;

  if not found then
    raise exception 'child SKU % not found', p_child_sku_id;
  end if;

  -- Flipping to non-inventory: retroactively undo the fictional inventory and
  -- stuck backorders this SKU left behind (mirrors migration 0068 §6b–6d, scoped
  -- to this child). No-op when turning tracking back on.
  if not v_track then
    -- 1. Zero fictional stock/reservations (never physically existed; direct
    --    level reset, not the ledger — nothing real to audit).
    update public.inventory_levels il
       set on_hand = 0, reserved = 0, layby = 0, updated_at = now()
     where il.child_sku_id = p_child_sku_id
       and (il.on_hand <> 0 or il.reserved <> 0 or il.layby <> 0);

    -- 2. Clear the backorder shortfall this line created on any open order.
    update public.order_line_items oli
       set backordered_qty = 0
     where oli.child_sku_id = p_child_sku_id
       and coalesce(oli.backordered_qty, 0) > 0;

    -- 3. Recompute the order-level flag for the orders this SKU touched: an order
    --    stays flagged only if a REAL line is still short.
    update public.orders o
       set backordered = exists (
         select 1 from public.order_line_items x
          where x.order_id = o.id and coalesce(x.backordered_qty, 0) > 0)
     where o.id in (
             select oli.order_id from public.order_line_items oli
              where oli.child_sku_id = p_child_sku_id)
       and o.status not in ('fulfilled', 'cancelled')
       and o.backordered is distinct from exists (
         select 1 from public.order_line_items x
          where x.order_id = o.id and coalesce(x.backordered_qty, 0) > 0);
  end if;

  return v;
end;
$$;

grant execute on function public.set_child_track_inventory(uuid, boolean) to authenticated;

comment on function public.set_child_track_inventory is
  'Admin/manager-only manual override of child_skus.track_inventory. false = '
  'service/fee SKU that skips all inventory ops (reserve/backorder/consume/'
  'release/receive) AND retroactively clears its fictional stock + stuck '
  'backorders (mirrors migration 0068, scoped to this child); true = normal '
  'physical inventory, no cleanup. Change is audit-logged by the child_skus '
  'audit trigger.';

commit;
