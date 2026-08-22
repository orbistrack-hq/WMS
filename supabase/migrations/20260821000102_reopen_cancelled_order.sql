-- ============================================================================
-- WMS — Migration 0102: reopen_cancelled_order
--
-- WHY. OT is meant to follow the store (Shopify/WooCommerce), never the other
-- way around — but applyWooLifecycleUpdate / applyShopifyLifecycleUpdate treat
-- 'cancelled' as a one-way, terminal ratchet: once OT cancels an order, no
-- later webhook can ever move it, even one proving the store itself no longer
-- considers it cancelled.
--
-- Concretely: WooCommerce's `order.deleted` webhook fires on the order being
-- moved to TRASH (a reversible action), not necessarily a permanent delete —
-- effectiveWooLifecycle (lib/woocommerce/types.ts) maps it straight to
-- 'cancelled' with no way to tell a real delete from a trash that gets undone.
-- If the order is then restored (back to e.g. 'processing'), Woo fires a normal
-- order.updated — which OT's forward-only guard silently drops, because the
-- order is already terminal. The order is then stuck cancelled in OT
-- indefinitely while Woo shows it very much alive, and nobody is working it.
--
-- WHAT. reopen_cancelled_order(order, paid) — for a 'cancelled' STANDARD order:
--   * p_paid = true  (store shows it paid/processing): re-reserves each
--     inventory-tracked line via apply_order_creation's backorder-tolerant path
--     (reserve what's available now, backorder the rest — same as a brand-new
--     order; safe because cancel_order already fully released this order's
--     prior reservation, so there is nothing to double-book), moves status to
--     'created'.
--   * p_paid = false (store still shows pending/on-hold, unpaid): moves status
--     to 'pending_payment' instead — mirrors how a FRESH unpaid order is held
--     (migration 0071/0072): reserves NOTHING until the store reports payment,
--     at which point activate_pending_order (already wired into
--     applyToHeldOrder) promotes it the normal way.
--   * clears any stale backordered_qty first so it's recomputed fresh (paid
--     path only — held orders carry none);
--   * clears cancelled_at either way.
-- Unlike fulfill_cancelled_order the paid path makes no inventory judgment
-- calls (no on_hand touched, nothing to backorder-demote from another order) —
-- reserving is best-effort by design, so it cannot fail the way fulfilling
-- can. Callable from the service-role webhook path (no app_role() check blocks
-- a null JWT role — see force_fulfill_order's same, deliberate pattern) as well
-- as an admin/manager-gated manual action for orders found via the ShipStation
-- reconcile screen without a fresh webhook to trigger the automatic path.
--
-- Net-new; the rollback drops it.
-- ============================================================================

begin;

create or replace function public.reopen_cancelled_order(
  p_order_id uuid,
  p_paid     boolean default true
)
returns public.orders language plpgsql as $$
declare v public.orders;
begin
  -- Defense-in-depth for the manual/UI path: a real end-user JWT must be
  -- admin/manager. A service-role call (the automatic webhook path) carries no
  -- 'sub' claim, so app_role() reads null and this IF is skipped (PL/pgSQL
  -- treats a null condition as false) — same deliberate loophole
  -- force_fulfill_order / fulfill_cancelled_order rely on.
  if public.app_role() not in ('admin', 'manager') then
    raise exception 'reopen_cancelled_order requires the admin or manager role'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v from public.orders where id = p_order_id for update;
  if not found then raise exception 'Order % not found', p_order_id; end if;
  if v.status <> 'cancelled' then
    raise exception 'reopen_cancelled_order is for cancelled orders only (order % is %)', p_order_id, v.status;
  end if;
  if v.order_type <> 'standard' then
    raise exception 'reopen_cancelled_order is for standard orders only (order % is %)', p_order_id, v.order_type;
  end if;

  if not p_paid then
    -- Still unpaid at the store: hold, same as a fresh unpaid order — reserves
    -- nothing until a later webhook reports payment (applyToHeldOrder already
    -- handles that promotion).
    update public.orders
       set status = 'pending_payment', cancelled_at = null, backordered = false
     where id = p_order_id returning * into v;
    return v;
  end if;

  update public.order_line_items set backordered_qty = 0 where order_id = p_order_id;
  update public.orders
     set status = 'created', cancelled_at = null, backordered = false
   where id = p_order_id;

  perform public.apply_order_creation(p_order_id, true);  -- backorder-tolerant re-reserve

  select * into v from public.orders where id = p_order_id;
  return v;
end;
$$;

grant execute on function public.reopen_cancelled_order(uuid, boolean) to authenticated;

comment on function public.reopen_cancelled_order is
  'Reopens a cancelled STANDARD order the store (Shopify/WooCommerce) no longer considers cancelled — e.g. a WooCommerce order.deleted webhook (fires on Trash, reversible) that was later restored. If p_paid, re-reserves each line via apply_order_creation''s backorder-tolerant path (reserve what''s available, backorder the rest — safe since cancel_order already released this order''s prior reservation) and moves status to created; otherwise holds it as pending_payment (reserves nothing), matching how a fresh unpaid order is handled. Called automatically from the Woo/Shopify webhook lifecycle handlers (service-role, bypasses the role gate) when a later event shows the order genuinely open again, and available as an admin/manager-gated manual action for orders found via other means (e.g. the ShipStation reconcile screen).';

commit;
