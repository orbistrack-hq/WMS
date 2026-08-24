-- Rollback for migration 0106. Removes the per-function statement_timeout
-- override, reverting landed_margin_report to the role default (8s).

begin;

alter function public.landed_margin_report(date, date)
  reset statement_timeout;

commit;
