-- WMS — Migration 0027 (landed_margin_report): DOWN
-- Purely additive: one reporting view. Reverse = drop it.
begin;
drop view if exists public.landed_margin_report;
commit;
