-- ============================================================================
-- WMS — Migration 0061: receiving stock promotes waiting backorders
--
-- BUG. The backorder model (migration 0024) auto-promotes waiting order lines
-- when stock arrives — but promotion was only wired into adjust_stock() and
-- set_on_hand_to(). receive_stock() (0002) bumps on_hand and returns, never
-- calling promote_backorders(). So the two most common "stock just arrived"
-- paths silently leave backorders stuck:
--   * the inventory Receive tab (app calls receive_stock), and
--   * intake -> allocate, which credits each child's on_hand via receive_stock
--     (see 0029 / 0043). Allocation is the PRIMARY way ounce-special / BOGO
--     child SKUs get their first independent stock.
-- Observed: WOO-109977 imported with 4 units short on ounce-special children;
-- ops received/allocated stock, but backordered_qty stayed > 0, so
-- apply_order_fulfillment kept raising "N unit(s) still backordered awaiting
-- stock" even though the shelf was full.
--
-- FIX. Call promote_backorders() at the end of receive_stock (p_qty is always
-- > 0 here), then re-lock to return inventory_levels reflecting the reservations
-- just made — exactly the pattern adjust_stock / set_on_hand_to already use.
-- This fixes the Receive tab AND intake->allocate in one place, since allocate
-- delegates to receive_stock.
--
-- NOTE: CREATE OR REPLACE resets unspecified attributes, so SECURITY DEFINER and
-- the pinned search_path (set by migration 0003) are re-declared here — omitting
-- them would silently unlock the inventory door.
--
-- Signature and grants unchanged. Reverse with the matching down.
-- ============================================================================

begin;

create or replace function public.receive_stock(
  p_child_sku_id uuid, p_qty integer,
  p_ref_type text default 'receipt', p_ref_id uuid default null, p_note text default null
) returns public.inventory_levels
language plpgsql security definer set search_path = '' as $$
declare v public.inventory_levels;
begin
  if p_qty <= 0 then raise exception 'receive qty must be positive (got %)', p_qty; end if;
  perform public._inv_lock(p_child_sku_id);
  v := public._inv_write(
    p_child_sku_id, p_qty, 0, 0, 'receipt', p_ref_type, p_ref_id, p_note);
  -- Newly-received units flow to the oldest waiting order first, then the flag
  -- clears for any order made whole. No-op when nothing is backordered.
  perform public.promote_backorders(p_child_sku_id);
  return public._inv_lock(p_child_sku_id);   -- reflect reservations just made
end;
$$;

commit;
