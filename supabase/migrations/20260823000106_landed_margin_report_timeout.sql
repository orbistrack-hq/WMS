-- ============================================================================
-- WMS — Migration 0106: give landed_margin_report room to actually finish
--
-- WHY. The `authenticated` role (what the live app's API requests run as)
-- has statement_timeout=8s — a sane default that protects the DB from
-- runaway client queries. Diagnostics on the live DB showed this was never
-- really the problem: EXPLAIN cost for a 30-day window is ~78,208 vs ~41,210
-- for a 23-day window that succeeds — a real but modest ~1.9x difference,
-- not a blowup. There's no data skew (order volume is evenly spread day to
-- day, no outlier fulfillment group). This is a legitimate report that
-- genuinely needs a bit more than 8s once the window gets past ~3 weeks of
-- this site's real order volume (~100/day) — not a bug to fix, a budget to
-- extend.
--
-- FIX. Scope the extension to this one function via ALTER FUNCTION ... SET,
-- rather than raising authenticated's global statement_timeout — that would
-- loosen the 8s protection for every other authenticated query in the app,
-- which is not something this report's slowness justifies.
-- ============================================================================

begin;

alter function public.landed_margin_report(date, date)
  set statement_timeout = '30s';

commit;
