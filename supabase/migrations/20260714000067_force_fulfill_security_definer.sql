-- ============================================================================
-- WMS — Migration 0067: force_fulfill_order must run SECURITY DEFINER
--
-- BUG. force_fulfill_order (migration 0066) was left SECURITY INVOKER, but it
-- writes its audit note by calling public._inv_write directly (a zero-delta
-- 'correction' ledger row recording the reason + units shipped without stock).
-- Migration 0003 ("lock the inventory door") REVOKED execute on _inv_write from
-- authenticated and made every stock primitive SECURITY DEFINER so only the
-- owner context can reach the raw writer. So when a manager (role authenticated)
-- ran force_fulfill_order, the inline _inv_write call failed with:
--     "permission denied for function _inv_write"
-- The role gate itself passed — the error is purely the sealed writer.
--
-- (release_stock and charge_order_pick_fee already worked: they are themselves
-- SECURITY DEFINER, so calling them from an INVOKER function is fine. Only the
-- DIRECT _inv_write call was the problem — the same reason fulfill_order_no_stock
-- never hit this: it doesn't touch _inv_write directly.)
--
-- FIX. Promote force_fulfill_order to SECURITY DEFINER with a pinned, empty
-- search_path — exactly what migration 0003 does for _inv_write / reserve_stock /
-- release_stock / consume_stock / receive_stock / adjust_stock. The function's
-- object references are all schema-qualified (public.*), so the empty search_path
-- is safe and closes the search_path-hijack vector. The role gate is unaffected:
-- app_role() / auth.uid() read the JWT, not the SQL role, so the manager is still
-- identified for both the permission check and the ledger actor.
--
-- No body change and no signature change, so grants are preserved. Reverse with
-- the matching down (back to SECURITY INVOKER, reset search_path).
-- ============================================================================

begin;

alter function public.force_fulfill_order(uuid, text, timestamptz)
  security definer set search_path = '';

commit;
