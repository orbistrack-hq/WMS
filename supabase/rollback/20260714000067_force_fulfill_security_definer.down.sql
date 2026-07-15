-- ============================================================================
-- Rollback 0067 — return force_fulfill_order to SECURITY INVOKER.
-- Note: with this reverted the function's direct _inv_write call is denied for
-- non-owner callers again (the original 0066 bug); reversing is provided only
-- for a clean migration round-trip.
-- ============================================================================

begin;

alter function public.force_fulfill_order(uuid, text, timestamptz)
  security invoker reset search_path;

commit;
