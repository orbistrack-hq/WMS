-- ============================================================================
-- Rollback 0060 — drop defer_outbound_inventory_job.
--
-- Safe: only the drain's circuit breaker calls it, and the drain tolerates its
-- absence (a failed defer just leaves the job 'processing' for the reaper to
-- recover). Removing it disables cooldown-parking, not correctness.
-- ============================================================================

begin;

drop function if exists public.defer_outbound_inventory_job(uuid, timestamptz);

commit;
