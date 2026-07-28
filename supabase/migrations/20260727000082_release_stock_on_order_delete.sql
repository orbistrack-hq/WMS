-- ============================================================================
-- WMS — Migration 0082: release reserved stock when an order is deleted
--
-- PROBLEM
--   Deleting an order silently stranded its reservation. order_line_items is
--   ON DELETE CASCADE, so the lines vanished while inventory_levels.reserved
--   stayed inflated, and no order was left that could ever release it. Result:
--   stock physically on the shelf reading as unavailable, forever.
--
--   Confirmed in production 2026-07-27: a batch of deletions on 2026-07-06..09
--   left ~1,443 units stranded (cleaned up by the fresh-start recompute on
--   07-09), and a later batch the same day left ~42 units still stranded across
--   33 SKUs — 15 of which showed available = 0 with stock on hand.
--
--   scripts/fresh_start_delete_past_orders.sql knew about this hazard and
--   compensated with a recompute. That only helps deletions that go through
--   that one script. This migration makes the release automatic for every path.
--
-- DESIGN DECISION — auto-release rather than block the delete
--   The alternative is a hard RAISE that refuses to delete an order holding
--   stock, forcing cancel_order() first. Rejected because:
--     * it would break the fresh-start script and any future bulk cleanup,
--     * it turns a routine admin action into a puzzle for whoever hits it,
--     * the inventory outcome of "delete an order holding stock" is not
--       ambiguous — the stock must go back. There is no judgement call to
--       escalate to a human.
--   So the trigger does the obvious right thing and leaves a ledger trail.
--   If you later decide deletes should be forbidden outright, that is a
--   one-line change to this function (raise instead of release).
--
-- WHAT IT DOES, BY STATUS
--   created / picking / packed  standard → release_stock the RESERVED portion
--                               layaway  → layaway_cancel (returns to on_hand)
--   pending_payment             nothing — a held order never reserved (0071)
--   fulfilled                   nothing — stock was consumed and shipped
--   cancelled                   nothing — already released
--   returned                    nothing — already restocked to on_hand (0041)
--   track_inventory = false     skipped — service/fee SKUs never reserve (0068)
--
--   The 'fulfilled' branch is a backstop, not a routine path: fulfill_order
--   snapshots a pick fee into billing_charges, whose order_id FK is ON DELETE
--   RESTRICT, so a fulfilled order cannot be deleted until that charge is
--   cleared first (test 40 asserts the 23503). The branch still matters for the
--   bulk-cleanup path, which deletes billing_charges up front.
--
-- LEDGER
--   Releases go through the existing guarded primitives, so they write normal
--   'order_release' / 'layaway_cancel' rows referencing the line item id. That
--   reference is deliberate: it keeps the orphan detector in
--   scripts/reconcile-inventory-drift.sql (Q10) accurate, since it pairs a
--   reserve with its release by reference_id. The order-level DELETE is
--   recorded separately by the existing audit_log trigger.
--
-- CLAMPING
--   The release is clamped to what inventory_levels actually holds. If reserved
--   has already drifted low, a delete must not fail with a constraint error —
--   deleting is not the moment to litigate pre-existing drift. Use
--   scripts/recompute-reservations.sql for that.
--
-- COMPOSES WITH THE RECOMPUTE
--   scripts/fresh_start_delete_past_orders.sql still works unchanged: the
--   trigger releases during the delete, then the recompute SETS reserved to the
--   surviving claim. Setting an already-correct value is a no-op, not a
--   double-correction.
--
-- Reverse with rollback/20260727000082_release_stock_on_order_delete.down.sql.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Trigger function
--    SECURITY DEFINER + pinned search_path: it reaches the inventory primitives
--    sealed by migration 0003, and must work regardless of which app role
--    performs the delete. All references are schema-qualified.
--    BEFORE DELETE matters — order_line_items still exist at this point; the
--    CASCADE has not fired yet.
-- ---------------------------------------------------------------------------
create or replace function public.release_stock_on_order_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r        record;
  v_want   integer;
  v_have   integer;
  v_take   integer;
begin
  -- Only these three states hold stock. Everything else has already settled.
  if old.status not in ('created','picking','packed') then
    return old;
  end if;

  for r in
    select oli.id,
           oli.child_sku_id,
           oli.quantity,
           coalesce(oli.backordered_qty, 0) as backordered_qty,
           coalesce(cs.track_inventory, true) as track_inventory
      from public.order_line_items oli
      join public.child_skus cs on cs.id = oli.child_sku_id
     where oli.order_id = old.id
  loop
    -- Service / fee SKUs (Route Shipping Protection, Rush Upgrade) never
    -- reserved anything, so there is nothing to give back.
    if not r.track_inventory then
      continue;
    end if;

    if old.order_type = 'layaway' then
      -- Layaway removed the units from on_hand at booking; cancelling returns
      -- them. Layaway never backorders, so the full quantity applies.
      v_want := r.quantity;
      select layby into v_have
        from public.inventory_levels
       where child_sku_id = r.child_sku_id;
      v_take := least(coalesce(v_have, 0), v_want);
      if v_take > 0 then
        perform public.layaway_cancel(
          r.child_sku_id, v_take, 'order_line_item', r.id);
      end if;

    else
      -- Standard: only the portion that was actually reserved. A backordered
      -- remainder was never reserved and must not be released (migration 0024).
      v_want := r.quantity - r.backordered_qty;
      if v_want > 0 then
        select reserved into v_have
          from public.inventory_levels
         where child_sku_id = r.child_sku_id;
        v_take := least(coalesce(v_have, 0), v_want);
        if v_take > 0 then
          perform public.release_stock(
            r.child_sku_id, v_take, 'order_line_item', r.id);
        end if;
      end if;
    end if;
  end loop;

  return old;
end;
$$;

comment on function public.release_stock_on_order_delete is
  'BEFORE DELETE on orders: returns any stock the order was holding. Standard orders release the reserved portion (quantity - backordered_qty); layaway orders return layby to on_hand. No-ops for pending_payment / fulfilled / cancelled / returned and for non-inventory service SKUs. Clamped to the level actually held so a delete can never fail on pre-existing drift.';

-- ---------------------------------------------------------------------------
-- 2. Wire it up
-- ---------------------------------------------------------------------------
drop trigger if exists order_delete_release_stock on public.orders;

create trigger order_delete_release_stock
  before delete on public.orders
  for each row execute function public.release_stock_on_order_delete();

-- ---------------------------------------------------------------------------
-- 3. Promote backorders for anything freed by the release.
--    Freed units may let a waiting backordered line reserve. The trigger runs
--    per-row mid-delete, which is the wrong moment to reshuffle reservations,
--    so promotion is a deliberate follow-up rather than part of the trigger:
--      select public.promote_backorders(cs.id) from public.child_skus cs ...
--    (full statement in scripts/recompute-reservations.sql).
-- ---------------------------------------------------------------------------

commit;
